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
    cp ${./limit-output.awk} $out/limit-output.awk
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
          cp ${./limit-output.awk} limit-output.awk
          cp ${./protocol.js} protocol.js
          cp ${./protocol-test.js} protocol-test.js

          node --test protocol-test.js
          for line in $(seq 1 200); do
            if [ "$line" -eq 120 ]; then
              echo "vm test guest failure: Traceback (most recent call last):"
            elif [ "$line" -eq 121 ]; then
              echo "  File \"test.py\", line 7, in <module>"
            elif [ "$line" -eq 122 ]; then
              echo "ValueError: expected failure"
            elif [ "$line" -eq 123 ]; then
              echo "::vm-test::fail"
            elif [ "$line" -eq 124 ]; then
              echo "vm test failed: guest reported failure"
            else
              echo "line $line"
            fi
          done | awk -f limit-output.awk > output
          grep -F "[vm test output truncated: 70 lines omitted]" output
          grep -F "vm test guest failure: Traceback (most recent call last):" output
          grep -F '  File "test.py", line 7, in <module>' output
          grep -F "ValueError: expected failure" output
          grep -F "vm test failed: guest reported failure" output
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
      timeout ? 20,
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
        timeout ${toString (timeout + 5)} node ${runner}/run-test.js \
          --cpus ${toString cpus} \
          ${linux}/dist/index.js \
          ${initramfs} \
          ${lib.optionalString (disk != null) "disk.img"} \
          --timeout-seconds ${toString timeout} \
          2>&1 | awk -f ${runner}/limit-output.awk
        status=''${PIPESTATUS[0]}
        set -e
        if [ "$status" -eq 124 ]; then
          echo "vm test failed: host timeout after ${toString (timeout + 5)} seconds" >&2
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
