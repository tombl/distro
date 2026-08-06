{
  apk,
  basic-init,
  busybox,
  curl,
  dropbear,
  file,
  git,
  jq,
  lua,
  make,
  image,
  openssl,
  python,
  quickjs,
  sqlite3,
  zstd,
  vm-test,
}:

let
  profile = apk.mkProfile {
    name = "distro-runner";
    depends = map apk.dep [
      basic-init.apk
      busybox.apk
      zstd.apk
      file.apk
      jq.apk
      lua.apk
      make.apk
      openssl.apk
      quickjs.apk
      python.apk
      sqlite3.apk
      curl.apk
      git.apk
      dropbear.apk
    ];
    files."/init" = {
      source = ./rootfs-init.sh;
      mode = "0755";
    };
    links."/bin/basic-init" = "/bin/init";
  };
  systemRepository = apk.mkRepository {
    name = "runner-system";
    packages = { inherit profile; };
    includeDependencies = true;
  };
  system = apk.mkSystem {
    name = "runner";
    repositories = [ systemRepository ];
    packages = [ profile ];
  };
  package = image.mkFilesystem {
    name = "runner-rootfs";
    root = system;
  };
in
package
// {
  checks.mount = vm-test.vmTest {
    name = "runner-rootfs-mount";
    initramfs = vm-test.mkInitramfs {
      name = "runner-rootfs-mount";
      init = ./rootfs-smoke-test.sh;
      contents = [ busybox ];
    };
    disk = package;
  };
}
