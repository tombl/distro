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

  sigsetjmpCheck = vm-test.vmTest {
    name = "basic-init-sigsetjmp";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-sigsetjmp";
      init = "${
        buildInitWith "basic-init-sigsetjmp" "tests/sigsetjmp.c" "-mllvm -wasm-enable-sjlj"
      }/bin/init";
    };
  };

  sigsetjmpHandlerCheck = vm-test.vmTest {
    name = "basic-init-sigsetjmp-handler";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-sigsetjmp-handler";
      init = "${
        buildInitWith "basic-init-sigsetjmp-handler" "tests/sigsetjmp-handler.c" "-mllvm -wasm-enable-sjlj"
      }/bin/init";
    };
  };

  signalSyscallReturnCheck =
    name: extraFlags:
    vm-test.vmTest {
      name = "basic-init-signal-syscall-return-${name}";
      initramfs = vm-test.mkInitramfs {
        name = "basic-init-signal-syscall-return-${name}";
        init = "${
          buildInitWith "basic-init-signal-syscall-return-${name}" "tests/signal-syscall-return.c" extraFlags
        }/bin/init";
      };
    };

  kernelMemoryGrowthCheck = vm-test.vmTest {
    name = "basic-init-kernel-memory-growth";
    initramfs = vm-test.mkInitramfs {
      name = "basic-init-kernel-memory-growth";
      init = "${buildInit "basic-init-kernel-memory-growth" "tests/kernel-memory-growth.c"}/bin/init";
    };
    cpus = 2;
  };
in
(buildInit "basic-init" "init.c").overrideAttrs {
  passthru.checks = {
    auxv = check "auxv";
    boot = check "boot";
    brk = check "brk";
    cancellation = check "cancellation";
    clone = check "clone";
    clone-fd = check "clone-fd";
    clone-job-control = check "clone-job-control";
    clone-latency = check "clone-latency";
    clone-multithreaded-no-vm = check "clone-multithreaded-no-vm";
    clone-memory-limit = check "clone-memory-limit";
    clone-nested = check "clone-nested";
    clone-no-vm = check "clone-no-vm";
    clone-return = check "clone-return";
    clone-signal-handler = check "clone-signal-handler";
    clone-signals = check "clone-signals";
    clone-tid = check "clone-tid";
    clone-tls = check "clone-tls";
    credentials = check "credentials";
    cwd = check "cwd";
    eventfd-unix = check "eventfd-unix";
    futex = check "futex";
    heap-boundary-overread = check "heap-boundary-overread";
    initcpio = initcpioCheck;
    kernel-memory-growth = kernelMemoryGrowthCheck;
    large-executable = check "large-executable";
    malloc = check "malloc";
    malloc-failure = check "malloc-failure";
    malloc-thread = check "malloc-thread";
    memory-abi = memoryAbiCheck;
    named-semaphore = check "named-semaphore";
    proc-self-mem = check "proc-self-mem";
    pty = check "pty";
    setjmp = setjmpCheck;
    signal-syscall-return = signalSyscallReturnCheck "plain" "";
    signal-syscall-return-sjlj = signalSyscallReturnCheck "sjlj" "-DUSE_SJLJ -mllvm -wasm-enable-sjlj";
    signal-correctness = check "signal-correctness";
    sigsetjmp = sigsetjmpCheck;
    sigsetjmp-handler = sigsetjmpHandlerCheck;
    pthread-no-tls = check "pthread-no-tls";
    thread-local = check "thread-local";
    threads = check "threads";
    timer = check "timer";
    tls = check "tls";
    user-memory-growth = check "user-memory-growth";
    user-memory-rlimit = check "user-memory-rlimit";
    wallclock = check "wallclock";
  };
}
