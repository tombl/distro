{
  apk,
  apk-tools,
  busybox,
  image,
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
      jq = jq.apk;
      lua = lua.apk;
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
  profile = apk.mkProfile {
    name = "apk-install-test";
    depends = [
      (apk.dep apk-tools.apk)
      (apk.dep busybox.apk)
      (apk.dep repositoryPackage)
    ];
    files."/init" = {
      source = ../apk-tools/install-test.sh;
      mode = "0755";
    };
  };
  systemRepository = apk.mkRepository {
    name = "apk-install-system";
    packages = { inherit profile; };
    includeDependencies = true;
  };
  system = apk.mkSystem {
    name = "apk-install-test";
    repositories = [ systemRepository ];
    packages = [ profile ];
  };
  rootfs = image.mkFilesystem {
    name = "apk-install-test";
    root = system;
    format = "ext4";
    size = "128M";
  };
in
{
  install = vm-test.vmTest {
    name = "apk-tools-install";
    initramfs = image.bootInitramfs;
    disk = rootfs;
  };
}
