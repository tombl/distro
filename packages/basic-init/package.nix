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
    clone-return = check "clone-return";
    clone-tid = check "clone-tid";
    cwd = check "cwd";
    malloc = check "malloc";
    proc-self-mem = check "proc-self-mem";
    threads = check "threads";
    tls = check "tls";
  };
}
