# Build-platform test harness: boots the kernel under Node and asserts on a
# pass marker. See docs/architecture.md, "Testing".
{
  apk,
  pkgs,
  lib,
  image,
  linux,
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

  mkTestInitramfs =
    args:
    image.mkInitramfs (
      args
      // {
        files = (args.files or { }) // {
          "/vm-test-setup-dev-fd" = ./setup-dev-fd.sh;
        };
      }
    );

  vmTest =
    {
      name,
      initramfs,
      disk ? null,
      cpus ? 1,
    }:
    pkgs.runCommand "vm-test-${name}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        ${lib.optionalString (disk != null) ''
          cp ${disk} disk.img
          chmod u+w disk.img
        ''}
        set +e
        timeout --kill-after=5 300 node ${runner}/run-test.js \
          --cpus ${toString cpus} \
          ${linux}/dist/index.js \
          ${initramfs} \
          ${lib.optionalString (disk != null) "disk.img"} \
          2>&1
        status=$?
        set -e
        if [ "$status" -eq 124 ]; then
          echo "vm test failed: watchdog expired after 300 seconds" >&2
        fi
        [ "$status" -eq 0 ] || exit "$status"
        mkdir $out
      '';

  installedTest =
    {
      name,
      init,
      contents ? [ ],
      files ? { },
      cpus ? 1,
    }:
    let
      fixtureName = lib.replaceStrings [ "_" ] [ "-" ] name;
      toApk =
        index: value:
        if builtins.isAttrs value && ((value.isApk or false) || (value.guestPackage or false)) then
          apk.packageFrom value
        else
          apk.mkPackage {
            payload = value;
            name = "${fixtureName}-fixture-${toString index}";
            version = "0-r0";
          };
      contentPackages = lib.imap0 toApk contents;
      profile = apk.mkProfile {
        name = "${fixtureName}-test";
        depends = map apk.dep contentPackages;
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
      repository = apk.mkRepository {
        name = "${fixtureName}-test";
        packages = { inherit profile; };
        includeDependencies = true;
      };
      system = apk.mkSystem {
        name = "${fixtureName}-test";
        repositories = [ repository ];
        packages = [ profile ];
      };
      disk = image.mkFilesystem {
        name = "${fixtureName}-test";
        root = system;
        # Package checks are disposable machines and commonly exercise writes
        # to /etc, /root, and /var. Keep production image policy separate from
        # this mutable test fixture.
        format = "ext4";
      };
    in
    assert lib.assertMsg (!(files ? "/init")) "installedTest files cannot define /init; use init";
    assert lib.assertMsg (
      !(files ? "/vm-test-setup-dev-fd")
    ) "installedTest files cannot override /vm-test-setup-dev-fd";
    vmTest {
      inherit cpus name disk;
      initramfs = image.bootInitramfs;
    };
in
{
  mkInitramfs = mkTestInitramfs;
  inherit installedTest runner vmTest;
  recurseForDerivations = true;
}
