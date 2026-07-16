{
  run,
  lib,

  cpio,
  deno,
  linux,
}:

let
  runnerBase =
    run
      {
        name = "vm-test-runner";
        src = ./.;
      }
      ''
        mkdir $out
        cp limit-output.awk protocol.js run-test.js $out/
      '';

  runner = runnerBase // {
    checks.protocol =
      run
        {
          name = "vm-test-protocol-check";
          src = ./.;
          path = [ deno ];
        }
        ''
          export HOME=$TMPDIR/home
          export DENO_DIR=$TMPDIR/deno
          mkdir -p $HOME $DENO_DIR
          deno test --no-config --allow-read protocol-test.js
          for line in $(seq 1 200); do
            if [ "$line" -eq 120 ]; then
              echo "vm test failed: expected failure"
            else
              echo "line $line"
            fi
          done | awk -f limit-output.awk > output
          grep -F "[vm test output truncated: 70 lines omitted]" output
          grep -F "vm test failed: expected failure" output
          mkdir $out
        '';
  };

  mkInitramfs =
    {
      name,
      init,
      contents ? [ ],
    }:
    run
      {
        name = "${name}.cpio";
        path = [ cpio ];
      }
      ''
        mkdir -p root/dev root/proc root/sys root/tmp
        ${lib.concatMapStringsSep "\n" (content: "cp -RP ${content}/. root/") contents}
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
    }:
    run
      {
        name = "vm-test-${name}";
        path = [ deno ];
      }
      ''
        export HOME=$TMPDIR/home
        export DENO_DIR=$TMPDIR/deno
        mkdir -p $HOME $DENO_DIR
        ${lib.optionalString (disk != null) ''
          cp ${disk} disk.ext4
          chmod u+w disk.ext4
        ''}
        set +e
        timeout 20 deno run --allow-all ${runner}/run-test.js \
          ${linux}/index.js \
          ${initramfs} \
          ${lib.optionalString (disk != null) "disk.ext4"} \
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
