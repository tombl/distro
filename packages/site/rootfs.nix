{
  busybox,
  curl,
  git,
  guest-agent,
  jq,
  less,
  mkRootfs,
  pkgs,
  sqlite3,
  vim,
}:

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
mkRootfs {
  name = "site-rootfs";
  init = "${guest-agent}/bin/linux-guest-agent";
  contents = [
    busybox
    sqlite3
    jq
    git
    vim
    less
    curl
  ];
  files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
    nameserver 192.0.2.1
  '';
  format = "squashfs";
}
