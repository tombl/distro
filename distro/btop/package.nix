{
  pkgs,
  stdenv,
  src ? pkgs.fetchFromGitHub {
    owner = "aristocratos";
    repo = "btop";
    rev = "v1.4.7";
    hash = "sha256-3gECGBSWcGTYQkUlD4X2zrxZVvH2x2xfh5zdZ2jJbDQ=";
  },
  busybox,
  ncurses,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "btop";
  version = "1.4.7";
  inherit src;

  nativeBuildInputs = [ pkgs.cmake ];

  # GPU support dlopens vendor libraries, which a static-only platform
  # cannot load. LTO would need the sysroot built as bitcode.
  cmakeFlags = [
    "-DBTOP_GPU=OFF"
    "-DBTOP_LTO=OFF"
  ];

  passthru.checks = {
    functionality = vm-test.installedTest {
      name = "btop-functionality";
      init = ./functionality-test.sh;
      contents = [
        busybox
        ncurses
        finalAttrs.finalPackage
      ];
    };
  };
})
