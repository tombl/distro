# Build-platform test harness: boots the kernel under Node and asserts on a
# pass marker. See docs/architecture.md, "Testing".
{
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
in
{
  mkInitramfs = mkTestInitramfs;
  inherit runner vmTest;
  recurseForDerivations = true;
}
