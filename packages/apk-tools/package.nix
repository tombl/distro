{
  pkgs,
  stdenv,
  src,
  openssl,
  zlib,
}:

stdenv.mkDerivation {
  pname = "apk-tools";
  version = "3.0.5";
  inherit src;

  patches = [
    ./callback-clone.patch
    ./no-mmap.patch
  ];

  nativeBuildInputs = [
    pkgs.meson
    pkgs.ninja
    pkgs.pkg-config
    pkgs.lua5_3
  ];

  # libfetch is bundled. zlib implements v2 gzip and the deflate compression
  # used by this distro's v3 repository; OpenSSL supplies signatures and HTTPS.
  buildInputs = [
    openssl
    zlib
  ];

  mesonFlags = [
    "-Darch=wasm32"
    "-Ddefault_library=static"
    "-Dprefer_static=true"
    "-Ddocs=disabled"
    "-Dhelp=enabled"
    "-Dlua=disabled"
    "-Dlua_bin=lua"
    "-Dpython=disabled"
    "-Dtests=disabled"
    "-Dzstd=disabled"
  ];

  # Meson surrounds mutually-referencing static archives with the ELF/GNU ld
  # --start-group spelling. wasm-ld resolves archive cycles itself and does not
  # accept those two options.
  postConfigure = ''
    substituteInPlace build.ninja \
      --replace-fail ' -Wl,--start-group ' ' ' \
      --replace-fail ' -Wl,--end-group' ' '
  '';

  postInstall = ''
    # The executable is statically linked, but libfetch still needs the default
    # trust store for HTTPS repositories at runtime.
    mkdir -p $out/etc/ssl
    cp ${openssl}/etc/ssl/cert.pem $out/etc/ssl/cert.pem
  '';
}
