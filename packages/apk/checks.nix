{
  apk,
  apk-tools,
  busybox,
  jq,
  lua,
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
  repositoryPayload = pkgs.runCommand "apk-install-repository-payload" { } ''
    mkdir -p $out/repo
    cp -R ${installRepository}/. $out/repo/
  '';
  repositoryPackage = apk.mkPackage {
    payload = repositoryPayload;
    name = "apk-install-repository";
    version = "1-r0";
  };
in
{
  install = vm-test.installedTest {
    name = "apk-tools-install";
    init = ../apk-tools/install-test.sh;
    contents = [
      apk-tools
      busybox
      repositoryPackage
    ];
  };
}
