{
  pkgs,
  stdenv,
}:

stdenv.mkDerivation {
  pname = "e2fsprogs";
  inherit (pkgs.e2fsprogs) version src;

  # configure builds generators that run on the build platform while the
  # filesystem tools themselves target wasm.
  depsBuildBuild = [ pkgs.stdenv.cc ];
  env.BUILD_CC = "${pkgs.stdenv.cc}/bin/cc";

  postPatch = ''
    # The Nix build sandbox intentionally has no /bin. This is only a progress
    # message; using the shell builtin keeps the cross-type probe functional.
    substituteInPlace config/parse-types.sh --replace-fail /bin/echo echo

    # wasm32 has 32-bit long but a 64-bit off_t. The upstream blkid fallback
    # selects the obsolete _llseek syscall from sizeof(long), even though plain
    # lseek already carries the complete offset on this ABI.
    substituteInPlace lib/blkid/llseek.c \
      --replace-fail 'SIZEOF_LONG == SIZEOF_LONG_LONG' 'SIZEOF_OFF_T >= 8'
  '';

  configureFlags = [
    "--disable-backtrace"
    "--disable-debugfs"
    "--disable-defrag"
    "--disable-e2initrd-helper"
    "--disable-fsck"
    "--disable-fuse2fs"
    "--disable-imager"
    "--disable-mmp"
    "--disable-nls"
    "--disable-resizer"
    "--disable-rpath"
    "--disable-tdb"
    "--disable-tls"
    "--disable-uuidd"
    "--without-libarchive"
    "--without-pthread"
    "--with-crond-dir=no"
    "--with-root-prefix=/"
    "--with-systemd-unit-dir=no"
    "--with-udev-rules-dir=no"
  ];

  # The installer needs the real ext4 formatter, not BusyBox's ext2-only
  # applet. Building only its library closure also avoids porting unrelated
  # interactive utilities whose pager implementation requires fork().
  buildPhase = ''
    runHook preBuild
    make top-deps
    for directory in lib/et lib/uuid lib/blkid lib/support lib/ext2fs lib/e2p; do
      make -C "$directory"
    done
    make -C misc mke2fs
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 misc/mke2fs "$out/sbin/mke2fs"
    install -Dm644 misc/mke2fs.conf "$out/etc/mke2fs.conf"
    runHook postInstall
  '';

  passthru.apk.replaces = [ "busybox" ];
}
