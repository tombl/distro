{
  basic-init,
  busybox,
  lib,
  linux-guest,
  pkgs,
  repository,
  runner,
  site,
  stdenv,
  vm-test,
}:

# The fixed layout behind $LOWLAND_TEST_ASSETS (scripts/test-assets.ts). The
# whole set is `nix build .#test-assets`, which is what tests build for
# themselves outside Nix. Each check instead gets `select [ ... ]`, a link farm
# of only the names it reads, so it reruns only when those assets change.

let
  test-program =
    name:
    stdenv.mkDerivation {
      pname = "linux-guest-${name}";
      version = "0.0.0";
      dontUnpack = true;
      buildPhase = ''
        $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
          -Wl,--fatal-warnings -o ${name} ${../guest-tests + "/${name}.c"}
      '';
      installPhase = ''
        mkdir -p $out/bin
        cp ${name} $out/bin/
      '';
    };

  assets = {
    # The guest image, kernel boot pieces and guest-side programs.
    "agent.img" = linux-guest.agentDisk;
    "rootfs.erofs" = linux-guest.rootfs;
    "rootfs.ext4" = linux-guest.ext4Root;
    "wrong-root.erofs" = linux-guest.wrongRoot;
    "boot.cpio" = vm-test.bootInitramfs;
    "lifecycle.erofs" = vm-test.installedDisk {
      name = "linux-guest-lifecycle";
      init = ../guest-tests/lifecycle-init.sh;
      contents = [ busybox ];
    };
    "network-test" = "${test-program "network-test"}/bin/network-test";
    "user-trap" = "${test-program "user-trap"}/bin/user-trap";
    "getdents-inode" = "${test-program "getdents-inode"}/bin/getdents-inode";

    # The runner's own disks.
    "runner-rootfs.erofs" = runner.rootfs;
    "runner-console.erofs" = vm-test.installedDisk {
      name = "linux-runner-console";
      init = ../runner/console-init.sh;
      contents = [ busybox ];
    };
    "runner-lifecycle.ext4" = vm-test.installedDisk {
      name = "linux-runner-lifecycle";
      format = "ext4";
      init = ../guest-tests/lifecycle-init.sh;
      contents = [ busybox ];
    };

    # Browser scenarios.
    "scheduler-handoff.erofs" = basic-init.schedulerHandoffDisk;
    "remote-vm.erofs" = basic-init.remoteMemoryDisk;
    "posix-spawn-stress.erofs" = basic-init.posixSpawnStressDisk;
    # Astro names the bundled worker by content hash.
    "opfs-disk-worker.js" = pkgs.runCommand "opfs-disk-worker.js" { } ''
      cp ${site.package}/_astro/opfs-disk-worker-*.js $out
    '';

    # The deployed site, and the candidate repository it installs from.
    site = site.package;
    apk = repository;
  };

  select = names: pkgs.linkFarm "lowland-test-assets" (lib.getAttrs names assets);
in
select (builtins.attrNames assets) // { inherit select; }
