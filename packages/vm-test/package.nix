# Build-platform test harness: boots the kernel under Node and asserts on a
# pass marker. See docs/architecture.md, "Testing".
{
  pkgs,
  lib,
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

  mkInitramfs =
    {
      name,
      init,
      contents ? [ ],
    }:
    pkgs.runCommand "${name}.cpio"
      {
        nativeBuildInputs = [
          pkgs.cpio
          pkgs.findutils
        ];
      }
      ''
        mkdir -p root/dev root/proc root/sys root/tmp
        ${lib.concatMapStringsSep "\n" (content: ''
          # --remove-destination so a later content's real file replaces an
          # earlier content's entry outright. Without it, cp writes *through* an
          # existing symlink: a GNU tool copied over busybox's applet symlink
          # (e.g. bin/sed -> busybox) would clobber the busybox binary itself
          # instead of shadowing the applet. "later wins" must replace, not follow.
          cp -RP --remove-destination ${content}/. root/
          # Each store path arrives read-only; keep the tree writable so a later
          # content can add files under a directory an earlier one created (e.g.
          # a second package populating /bin).
          chmod -R u+w root
        '') contents}
        cp ${init} root/init
        chmod 0755 root/init

        cd root
        find . -print0 | sort -z | cpio --null --reproducible --owner=0:0 -H newc -o > $out
      '';

  vmTest =
    {
      name,
      initramfs,
      disk ? null,
      memoryGrowth ? false,
    }:
    pkgs.runCommand "vm-test-${name}"
      {
        nativeBuildInputs = [ pkgs.nodejs ];
      }
      ''
        ${lib.optionalString (disk != null) ''
          cp ${disk} disk.ext4
          chmod u+w disk.ext4
        ''}
        set +e
        timeout 20 node ${runner}/run-test.js \
          ${linux}/dist/index.js \
          ${initramfs} \
          ${lib.optionalString (disk != null) "disk.ext4"} \
          ${lib.optionalString memoryGrowth "--memory-growth"} \
          2>&1 | awk -f ${runner}/limit-output.awk
        status=''${PIPESTATUS[0]}
        set -e
        if [ "$status" -eq 124 ]; then
          echo "vm test failed: host timeout after 20 seconds" >&2
        fi
        [ "$status" -eq 0 ] || exit "$status"
        mkdir $out
      '';
in
{
  inherit mkInitramfs runner vmTest;
  recurseForDerivations = true;
}
