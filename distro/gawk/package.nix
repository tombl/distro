{
  pkgs,
  stdenv,
  src ? pkgs.fetchzip {
    url = "https://ftp.gnu.org/gnu/gawk/gawk-5.3.1.tar.xz";
    hash = "sha256-dw4WPFQhuh+UXPKA48zlulFbuKbFc96eoNHHoiIDhL4=";
  },
  busybox,
  vm-test,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "gawk";
  version = "5.3.1";
  inherit src;

  configureFlags = [
    "--disable-nls"
    # No dynamic loading on wasm (no dlopen), so gawk's C extension API is off.
    "--disable-extensions"
    # Compile the overlaid guest locations into AWKPATH and the generated
    # passwd/group helpers; $out is only the DESTDIR staging root.
    "--prefix=/"
    "--datadir=/usr/share"
    "--libexecdir=/usr/libexec"
  ];

  installFlags = [ "DESTDIR=$(out)" ];
  dontPatchShebangs = true;

  # gawk creates every child with fork()+execl(): the system() builtin and the
  # pipe/coprocess redirections in io.c. wasm has no fork(); ordinary children
  # use posix_spawn with file actions. The pty coprocess uses callback clone so
  # setsid(), TIOCSCTTY, stdio attachment, and exec happen on a fresh child stack.
  patches = [
    ./wasm-posix-spawn.patch
    ./pty-callback-clone.patch
  ];

  postInstall = ''
    ! grep -R -F "$out" $out/bin/gawk $out/usr/share/awk
  '';

  passthru.checks = {
    functionality = vm-test.vmTest {
      name = "gawk-functionality";
      initramfs = vm-test.mkInitramfs {
        name = "gawk-functionality";
        init = ./functionality-test.sh;
        # busybox first, gawk last: the GNU binary must shadow busybox's applet.
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
