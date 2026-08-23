{
  stdenv,
  zig-toolchain,
  busybox,
  vm-test,
}:

let
  zig-smoke = stdenv.mkDerivation {
    pname = "zig-smoke";
    version = "0.0.0";
    src = ./.;

    nativeBuildInputs = [ zig-toolchain.hook ];

    postInstall = ''
      mv $out/bin/zig-smoke.wasm $out/bin/zig-smoke
    '';
  };
in
zig-smoke.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    checks.vm = vm-test.installedTest {
      name = "zig-smoke";
      init = ./init.sh;
      contents = [
        busybox
        zig-smoke
      ];
    };
  };
})
