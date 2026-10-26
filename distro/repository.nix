{
  apk,
  bootFiles,
  apk-tools,
  basic-init,
  bash,
  busybox,
  bzip2,
  ca-certificates,
  coreutils,
  curl,
  diffutils,
  dropbear,
  e2fsprogs,
  erofs-utils,
  file,
  findutils,
  gawk,
  git,
  grep,
  jq,
  less,
  lua,
  make,
  ncurses,
  openssl,
  patch,
  python,
  quickjs,
  readline,
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
# derivation carries its optional APK metadata as passthru.apk. Only packages a
# user may install belong here. Internal guest programs (the guest agent, test
# suites, smoke tests) reach their images as derivations through mkImage.
# bootFiles is the site's lowland-boot payload, published so installed
# machines upgrade it with `apk upgrade`.
apk.mkRepository {
  name = "repository";
  description = "tombl site demo repository";
  packages = {
    inherit
      apk-tools
      basic-init
      bash
      bootFiles
      busybox
      bzip2
      ca-certificates
      coreutils
      curl
      diffutils
      dropbear
      e2fsprogs
      erofs-utils
      file
      findutils
      gawk
      git
      grep
      jq
      less
      lua
      make
      ncurses
      openssl
      patch
      python
      quickjs
      readline
      sed
      sqlite3
      tar
      util-linux
      vim
      xz
      zlib
      zstd
      ;
  };
}
