{
  apk-tools,
  basic-init,
  busybox,
  ca-certificates,
  mkImage,
  vm-test,
}:

let
  package = mkImage {
    name = "runner-rootfs";
    packages = [
      apk-tools
      basic-init
      busybox
    ];
    files."/init" = {
      source = ../../runner/rootfs-init.sh;
      mode = "0755";
    };
    # A real copy, not a link: the wasm kernel cannot exec (or even stat -x)
    # through a symlink to an executable.
    files."/bin/basic-init" = "${basic-init}/bin/init";
  };
in
package
// {
  checks.mount = vm-test.installedTest {
    name = "runner-rootfs";
    init = ../../runner/rootfs-smoke-test.sh;
    contents = [
      apk-tools
      basic-init
      busybox
      ca-certificates
    ];
    files = {
      "/bin/basic-init" = "${basic-init}/bin/init";
    };
  };
}
