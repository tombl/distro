{
  pkgs,
  stdenv,
  vm-test,
}:

let
  buildInitWith =
    name: source: extraFlags:
    stdenv.mkDerivation {
      inherit name;
      src = ./.;

      buildPhase = ''
        runHook preBuild
        $CC ${extraFlags} -Wl,--fatal-warnings -o init ${source}
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out/bin
        cp init $out/bin/init
        runHook postInstall
      '';
    };

  buildInit = name: source: buildInitWith name source "";

  check =
    name:
    vm-test.vmTest {
      name = "basic-init-${name}";
      initramfs = vm-test.mkInitramfs {
        name = "basic-init-${name}";
        init = "${buildInit "basic-init-${name}" "tests/${name}.c"}/bin/init";
      };
    };

  moduleDefinedMemory =
    pkgs.runCommand "module-defined-memory.wasm"
      {
        nativeBuildInputs = [ pkgs.wabt ];
      }
      ''
        mkdir -p $out/bin
        wat2wasm ${./tests/module-defined-memory.wat} -o $out/bin/module-defined-memory
        chmod 0755 $out/bin/module-defined-memory
      '';

  memoryAbiCheck = vm-test.vmTest {
    name = "basic-init-memory-abi";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-memory-abi";
      init = "${buildInit "basic-init-memory-abi" "tests/memory-abi.c"}/bin/init";
      contents = [ moduleDefinedMemory ];
    };
  };

  initcpioPayload = pkgs.runCommand "basic-init-initcpio-payload" { } ''
    mkdir -p $out
    dd if=/dev/zero of=$out/payload bs=1M count=3 status=none
    printf 'start-of-payload' | dd of=$out/payload bs=1 seek=0 conv=notrunc status=none
    printf 'middle-of-payload' | dd of=$out/payload bs=1 seek=1572864 conv=notrunc status=none
    printf 'end-of-payload' | dd of=$out/payload bs=1 seek=3145712 conv=notrunc status=none
  '';

  initcpioCheck = vm-test.vmTest {
    name = "basic-init-initcpio";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-initcpio";
      init = "${buildInit "basic-init-initcpio" "tests/initcpio.c"}/bin/init";
      contents = [ initcpioPayload ];
    };
  };

  # setjmp/longjmp needs the Wasm SjLj lowering enabled at the call sites, so
  # this test is compiled with -mllvm -wasm-enable-sjlj rather than the default
  # flags. It exercises musl's __wasm_setjmp/__wasm_longjmp helpers end to end.
  setjmpCheck = vm-test.vmTest {
    name = "basic-init-setjmp";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-setjmp";
      init = "${buildInitWith "basic-init-setjmp" "tests/setjmp.c" "-mllvm -wasm-enable-sjlj"}/bin/init";
    };
  };

  kernelMemoryGrowthCheck = vm-test.vmTest {
    name = "basic-init-kernel-memory-growth";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-kernel-memory-growth";
      init = "${buildInit "basic-init-kernel-memory-growth" "tests/kernel-memory-growth.c"}/bin/init";
    };
    memoryGrowth = true;
  };
in
(buildInit "basic-init" "init.c").overrideAttrs {
  passthru.checks = {
    boot = check "boot";
    brk = check "brk";
    cancellation = check "cancellation";
    clone = check "clone";
    clone-multithreaded-no-vm = check "clone-multithreaded-no-vm";
    clone-memory-limit = check "clone-memory-limit";
    clone-no-vm = check "clone-no-vm";
    clone-return = check "clone-return";
    clone-tid = check "clone-tid";
    clone-tls = check "clone-tls";
    credentials = check "credentials";
    cwd = check "cwd";
    futex = check "futex";
    initcpio = initcpioCheck;
    kernel-memory-growth = kernelMemoryGrowthCheck;
    large-executable = check "large-executable";
    malloc = check "malloc";
    malloc-failure = check "malloc-failure";
    malloc-thread = check "malloc-thread";
    memory-abi = memoryAbiCheck;
    proc-self-mem = check "proc-self-mem";
    setjmp = setjmpCheck;
    pthread-no-tls = check "pthread-no-tls";
    thread-local = check "thread-local";
    threads = check "threads";
    tls = check "tls";
    user-memory-growth = check "user-memory-growth";
    user-memory-rlimit = check "user-memory-rlimit";
  };
}
