{
  apk,
  apk-tools,
  basic-init,
  busybox,
  bzip2,
  curl,
  dropbear,
  file,
  git,
  guest-agent,
  jq,
  kselftests,
  ltp,
  lua,
  make,
  ncurses,
  openssl,
  python,
  quickjs,
  readline,
  sqlite3,
  xz,
  zlib,
  zstd,
}:

# Repository membership lives separately from port metadata. This is the Nix
# equivalent of an aports repository directory: members bring their own binary
# package declarations and typed dependency graph.
apk.mkRepository {
  name = "main";
  packages = {
    inherit
      apk-tools
      basic-init
      busybox
      bzip2
      curl
      dropbear
      file
      git
      guest-agent
      jq
      kselftests
      ltp
      lua
      make
      ncurses
      openssl
      python
      quickjs
      readline
      sqlite3
      xz
      zlib
      zstd
      ;
  };
}
