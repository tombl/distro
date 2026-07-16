{
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
in
(buildInit "basic-init" "init.c").overrideAttrs {
  passthru.checks = {
    boot = check "boot";
    brk = check "brk";
    cancellation = check "cancellation";
    clone = check "clone";
    clone-no-vm = check "clone-no-vm";
    clone-return = check "clone-return";
    clone-tid = check "clone-tid";
    clone-tls = check "clone-tls";
    cwd = check "cwd";
    futex = check "futex";
    malloc = check "malloc";
    malloc-failure = check "malloc-failure";
    malloc-thread = check "malloc-thread";
    proc-self-mem = check "proc-self-mem";
    pthread-no-tls = check "pthread-no-tls";
    thread-local = check "thread-local";
    threads = check "threads";
    tls = check "tls";
  };
}
