{
  apk,
  apk-tools,
  bash,
  busybox,
  ca-certificates,
  coreutils,
  file,
  jq,
  lua,
  ncurses,
  openssl,
  pkgs,
  vm-test,
}:

let
  scriptPayload = pkgs.runCommand "apk-script-test-payload" { } ''
    mkdir -p $out/share/apk-script-test
    touch $out/share/apk-script-test/payload
  '';
  scriptedPackage = apk.mkPackage {
    payload = scriptPayload;
    name = "apk-script-test";
    version = "1-r0";
    scripts.post-install = ../apk-tools/post-install.sh;
  };
  installRepository = apk.mkRepository {
    name = "apk-install-targets";
    packages = {
      inherit scriptedPackage;
      inherit jq;
      inherit lua;
    };
  };
  userlandRepository = apk.mkRepository {
    name = "apk-userland-targets";
    packages = {
      inherit
        bash
        ca-certificates
        busybox
        coreutils
        file
        ncurses
        openssl
        ;
    };
  };
  repositoryPayload = pkgs.runCommand "apk-install-repository-payload" { } ''
    mkdir -p $out/repo
    cp -R ${installRepository}/. $out/repo/
  '';
  repositoryPackage = apk.mkPackage {
    payload = repositoryPayload;
    name = "apk-install-repository";
    version = "1-r0";
  };
  userlandRepositoryPayload = pkgs.runCommand "apk-userland-repository-payload" { } ''
    mkdir -p $out/repo
    cp -R ${userlandRepository}/. $out/repo/
  '';
  userlandRepositoryPackage = apk.mkPackage {
    payload = userlandRepositoryPayload;
    name = "apk-userland-repository";
    version = "1-r0";
  };
  storeReferences = pkgs.runCommand "apk-store-reference-check" { } ''
    mkdir -p clean bad
    printf '%s\n' guest-path > clean/path
    ${apk.checkStoreReferences}/bin/apk-check-store-references clean

    printf '%s\n' /nix/store/00000000000000000000000000000000-forbidden > bad/file
    ln -s /nix/store/11111111111111111111111111111111-forbidden bad/link
    if ${apk.checkStoreReferences}/bin/apk-check-store-references bad; then
      echo "store-reference checker accepted a contaminated payload" >&2
      exit 1
    fi
    touch $out
  '';
in
{
  install = vm-test.installedTest {
    name = "apk-tools-install";
    init = ../apk-tools/install-test.sh;
    contents = [
      apk-tools
      busybox
      ca-certificates
      repositoryPackage
    ];
  };
  userland = vm-test.installedTest {
    name = "apk-userland";
    init = ./userland-test.sh;
    contents = [
      apk-tools
      busybox
      ca-certificates
      userlandRepositoryPackage
    ];
  };
  store-references = storeReferences;
}
