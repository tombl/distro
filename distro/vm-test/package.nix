# Build-platform test harness: boots the kernel under Node and asserts on a
# pass marker. See docs/architecture.md, "Testing".
{
  apk,
  pkgs,
  lib,
  image,
  kernel,
}:

let
  runnerBase = pkgs.runCommand "vm-test-runner" { } ''
    mkdir $out
    cp ${./protocol.js} $out/protocol.js
    cp ${./run-test.js} $out/run-test.js
  '';

  runner = runnerBase // {
    checks.protocol =
      pkgs.runCommand "vm-test-protocol-check"
        {
          nativeBuildInputs = [ pkgs.nodejs ];
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
        nativeBuildInputs = [ pkgs.nodejs ];
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
          ${kernel}/dist/index.js \
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
      packages = map apk.packageFrom contents;
      repository = apk.mkRepository {
        name = "${fixtureName}-system";
        packages = lib.listToAttrs (
          map (p: {
            inherit (p) name;
            value = p;
          }) packages
        );
      };
      system = apk.mkSystem {
        name = "${fixtureName}-system";
        repositories = [ repository ];
        inherit packages;
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
    in
    assert lib.assertMsg (contents != [ ]) "installedDisk requires at least one APK package";
    assert lib.assertMsg (!(files ? "/init")) "installedDisk files cannot define /init; use init";
    assert lib.assertMsg (
      !(files ? "/vm-test-setup-dev-fd")
    ) "installedDisk files cannot override /vm-test-setup-dev-fd";
    image.mkFilesystem {
      name = "${fixtureName}-system";
      root = system;
      inherit format size;
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
      initramfs = image.bootInitramfs;
    };
in
{
  inherit
    installedDisk
    installedTest
    runner
    ;
  recurseForDerivations = true;
}
