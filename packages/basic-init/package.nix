{
  pkgs,
  stdenv,
  vm-test,
}:

let
  buildInit =
    name: source:
    stdenv.mkDerivation {
      inherit name;
      src = ./.;

      buildPhase = ''
        runHook preBuild
        $CC -Wl,--fatal-warnings -o init ${source}
        runHook postBuild
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out/bin
        cp init $out/bin/init
        runHook postInstall
      '';
    };

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
in
(buildInit "basic-init" "init.c").overrideAttrs {
  passthru.checks = {
    boot = check "boot";
    brk = check "brk";
    cancellation = check "cancellation";
    clone = check "clone";
    clone-multithreaded-no-vm = check "clone-multithreaded-no-vm";
    clone-no-vm = check "clone-no-vm";
    clone-return = check "clone-return";
    clone-tid = check "clone-tid";
    clone-tls = check "clone-tls";
    credentials = check "credentials";
    cwd = check "cwd";
    futex = check "futex";
    large-executable = check "large-executable";
    malloc = check "malloc";
    malloc-failure = check "malloc-failure";
    malloc-thread = check "malloc-thread";
    memory-abi = memoryAbiCheck;
    proc-self-mem = check "proc-self-mem";
    pthread-no-tls = check "pthread-no-tls";
    thread-local = check "thread-local";
    threads = check "threads";
    tls = check "tls";
  };
}
