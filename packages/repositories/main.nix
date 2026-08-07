{
  apk,
  apk-tools,
  basic-init,
  busybox,
  bzip2,
  ca-certificates,
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

# The published repository: the set of derivations the runtime package manager
# serves. Membership is the aports equivalent of a repository directory; each
# derivation carries its optional APK metadata as passthru.apk.
apk.mkRepository {
  name = "main";
  packages = {
    inherit
      apk-tools
      basic-init
      busybox
      bzip2
      ca-certificates
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
