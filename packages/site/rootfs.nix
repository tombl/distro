{
  busybox,
  curl,
  git,
  image,
  jq,
  less,
  pkgs,
  sqlite3,
  vim,
  vm-test,
}:

let
  # The distro packages are SDK-style outputs containing headers, static
  # archives, servers, and helper programs as well as their user-facing tools.
  # The browser demo only ships the runtime slice it exercises. In particular,
  # Git keeps its main binary and HTTP transport without carrying daemon,
  # server, CVS, SVN, and mail tooling that would dominate the download.
  runtime = pkgs.runCommand "site-userland" { } ''
    mkdir -p \
      $out/bin \
      $out/etc/ssl/certs \
      $out/share/terminfo/x \
      $out/usr/libexec/git-core \
      $out/usr/share

    cp -a ${sqlite3}/bin/sqlite3 $out/bin/
    cp -a ${jq}/bin/jq $out/bin/
    cp -a ${curl}/bin/curl $out/bin/
    cp -a ${curl}/etc/ssl/certs/ca-certificates.crt $out/etc/ssl/certs/
    cp -a ${less}/bin/less ${less}/bin/lesskey ${less}/bin/lessecho $out/bin/
    cp -a \
      ${less}/share/terminfo/x/xterm \
      ${less}/share/terminfo/x/xterm-256color \
      $out/share/terminfo/x/

    cp -a ${vim}/bin/vim ${vim}/bin/xxd $out/bin/
    cp -a ${vim}/share/vim $out/share/

    cp -a ${git}/usr/bin/git $out/bin/
    cp -a ${git}/usr/libexec/git-core/git-remote-http $out/usr/libexec/git-core/
    ln -s git-remote-http $out/usr/libexec/git-core/git-remote-https
    cp -a ${git}/usr/share/git-core $out/usr/share/
  '';
  package = image.mkGuestRootfs {
    name = "site-rootfs";
    contents = [ runtime ];
  };
in

# The image behind the site's live demos: the guest agent as init, so the
# page can exec/read/write against the machine, plus a userspace worth
# exploring from the terminal.
#
# Curation matters here in a way it doesn't for the `nix run` rootfs: the
# browser downloads this whole squashfs (gzipped) up front before the demo
# runs, so every binary added is bytes on the wire for every visitor. The set
# below is chosen for demo value per byte, with busybox underneath covering the
# everyday applets (ls, cat, grep, sed, awk, ...) for free.
#
#   sqlite3 - a real SQL engine in the browser; the flagship "it's Linux"
#             moment and already the smallest of the interesting binaries.
#   jq      - structured data munging, pairs naturally with the shell.
#   git     - clone/log/diff, and (with the http remote support from the port)
#             fetch over the network alongside the ping demo.
#   vim     - a real modal editor (plus xxd); the canonical "you can actually
#             work in here" demo.
#   less    - a proper pager, so git log / vim / large files feel right.
#   curl    - fetch real URLs from the terminal, showing the network stack off
#             beyond the ping demo (which is left untouched).
#
# python is deliberately left out: its stdlib pushes the payload up by roughly
# 30MB gzipped, more than doubling the download for a demo whose interactive
# story (sqlite3 + jq + git + vim + a shell) is already strong without it. It
# lives in the `nix run` image for anyone who wants the full system.
package
// {
  checks.runtime = vm-test.vmTest {
    name = "site-rootfs-runtime";
    initramfs = vm-test.mkInitramfs {
      name = "site-rootfs-runtime";
      init = ./rootfs-smoke-test.sh;
      contents = [ busybox ];
    };
    disk = package;
  };
}
