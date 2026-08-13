{
  apk,
  lib,
  bootFiles ? null,
  apk-tools,
  basic-init,
  bash,
  busybox,
  bzip2,
  coreutils,
  curl,
  diffutils,
  dropbear,
  e2fsprogs,
  file,
  findutils,
  gawk,
  git,
  guest-agent,
  grep,
  jq,
  kselftests,
  less,
  ltp,
  lua,
  make,
  ncurses,
  openssl,
  patch,
  python,
  quickjs,
  readline,
  rust-smoke,
  sed,
  sqlite3,
  tar,
  util-linux,
  vim,
  xz,
  zlib,
  zstd,
}:

# The published repository: the set of derivations the runtime package manager
# serves. Membership is the aports equivalent of a repository directory; each
# derivation carries its optional APK metadata as passthru.apk.
apk.mkRepository {
  name = "repository";
  packages = {
    inherit
      apk-tools
      basic-init
      bash
      busybox
      bzip2
      coreutils
      curl
      diffutils
      dropbear
      e2fsprogs
      file
      findutils
      gawk
      git
      guest-agent
      grep
      jq
      kselftests
      less
      ltp
      lua
      make
      ncurses
      openssl
      patch
      python
      quickjs
      readline
      rust-smoke
      sed
      sqlite3
      tar
      util-linux
      vim
      xz
      zlib
      zstd
      ;
  }
  // lib.optionalAttrs (bootFiles != null) { inherit bootFiles; };
}
