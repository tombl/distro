# Build-platform test harness: boots the kernel under Node and asserts on a
# pass marker. See docs/architecture.md, "Testing".
{
  busybox,
  pkgs,
  lib,
  lowland,
  mkImage,
}:

let
  # Installed tests boot through a tiny BusyBox initramfs that mounts the
  # first disk as the root. The cpio constructor exists only for it.
  mkInitramfs = import ./initramfs.nix { inherit lib pkgs; };
  bootInitramfs = import ./boot-initramfs.nix { inherit busybox mkInitramfs; };

  runnerBase = pkgs.runCommand "vm-test-runner" { } ''
    mkdir $out
    cp ${./protocol.js} $out/protocol.js
    cp ${./run-test.js} $out/run-test.js
  '';

  runner = runnerBase // {
    checks.protocol =
      pkgs.runCommand "vm-test-protocol-check"
        {
          nativeBuildInputs = [ pkgs.nodejs_26 ];
        }
        ''
          cp ${./protocol.js} protocol.js
          cp ${./protocol-test.js} protocol-test.js

          node --test protocol-test.js
          mkdir $out
        '';
  };

  # Low-level boot runner. It is deliberately private: callers construct an
  # APK-installed root with installedTest/installedDisk instead of supplying
  # an ad-hoc userspace image.
  bootInstalledSystem =
    {
      name,
      initramfs,
      disk ? null,
      disks ? [ ],
      cpus ? 1,
      heavy ? false,
    }:
    let
      allDisks = lib.optional (disk != null) disk ++ disks;
      diskCopies = lib.imap0 (index: source: {
        inherit index source;
        name = "disk-${toString index}.img";
      }) allDisks;
    in
    pkgs.runCommand "vm-test-${name}"
      {
        nativeBuildInputs = [ pkgs.nodejs_26 ];
        passthru.ci.heavy = heavy;
      }
      ''
        ${lib.concatMapStringsSep "\n" (diskCopy: ''
          cp ${diskCopy.source} ${diskCopy.name}
          chmod u+w ${diskCopy.name}
        '') diskCopies}
        set +e
        timeout --kill-after=5 300 node ${runner}/run-test.js \
          --cpus ${toString cpus} \
          ${lowland.machine}/dist/machine/index.js \
          ${initramfs} \
          ${lib.concatMapStringsSep " " (diskCopy: diskCopy.name) diskCopies} \
          2>&1
        status=$?
        set -e
        if [ "$status" -eq 124 ]; then
          echo "vm test failed: watchdog expired after 300 seconds" >&2
        fi
        [ "$status" -eq 0 ] || exit "$status"
        mkdir $out
      '';

  # An mkImage root whose /init is the test program. The setup helper lets
  # init scripts recreate /dev/fd, which devtmpfs does not provide.
  installedDisk =
    {
      name,
      init,
      contents ? [ ],
      files ? { },
      format ? "erofs",
      size ? "256M",
    }:
    let
      fixtureName = lib.replaceStrings [ "_" ] [ "-" ] name;
    in
    assert lib.assertMsg (contents != [ ]) "installedDisk requires at least one package";
    assert lib.assertMsg (!(files ? "/init")) "installedDisk files cannot define /init; use init";
    assert lib.assertMsg (
      !(files ? "/vm-test-setup-dev-fd")
    ) "installedDisk files cannot override /vm-test-setup-dev-fd";
    mkImage {
      name = "${fixtureName}-system";
      packages = contents;
      inherit format size;
      files = files // {
        "/init" = {
          source = init;
          mode = "0755";
        };
        "/vm-test-setup-dev-fd" = {
          source = ./setup-dev-fd.sh;
          mode = "0755";
        };
      };
    };

  installedTest =
    {
      name,
      init,
      contents ? [ ],
      files ? { },
      cpus ? 1,
      size ? "256M",
      # Every installed test boots a VM and needs an isolated CI runner. The
      # aggregate builder can otherwise start enough guests concurrently to
      # starve unrelated tests and produce misleading failures.
      heavy ? true,
      disks ? [ ],
    }:
    let
      fixtureName = lib.replaceStrings [ "_" ] [ "-" ] name;
      rootDisk = installedDisk {
        name = "${fixtureName}-test";
        inherit contents files init;
        # Package checks are disposable machines and commonly exercise writes
        # to /etc, /root, and /var. Keep production image policy separate from
        # this mutable test fixture.
        format = "ext4";
        inherit size;
      };
    in
    bootInstalledSystem {
      inherit cpus heavy name;
      disks = [ rootDisk ] ++ disks;
      initramfs = bootInitramfs;
    };
in
{
  inherit
    bootInitramfs
    installedDisk
    installedTest
    runner
    ;
  recurseForDerivations = true;
}
