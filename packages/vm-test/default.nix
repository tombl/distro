{
  pkgs,
  lib,
}:

let
  inherit (pkgs.wasmpkgs) busybox linux mkRootfs;

  mkTestInitramfs =
    baseBusybox:
    pkgs.stdenvNoCC.mkDerivation {
      name = "test-initramfs";

      nativeBuildInputs = [
        pkgs.cpio
        pkgs.gzip
      ];

      buildCommand = ''
        mkdir -p root/bin root/dev root/proc root/sys root/usr/bin root/usr/sbin root/sbin
        cp ${baseBusybox}/bin/busybox root/bin/busybox
        cat > root/init <<'EOF'
        #!/bin/busybox sh

        PATH=/bin:/sbin:/usr/bin:/usr/sbin
        export PATH

        /bin/busybox mkdir -p /dev /newroot
        /bin/busybox mount -t devtmpfs devtmpfs /dev

        i=0
        while [ ! -b /dev/vda ]; do
          if [ "$i" -ge 100 ]; then
            echo "Timed out waiting for /dev/vda"
            while true; do /bin/busybox sleep 86400; done
          fi

          i=$((i + 1))
          /bin/busybox sleep 0.1
        done

        /bin/busybox mount -t ext4 /dev/vda /newroot
        /bin/busybox mkdir -p /newroot/dev /newroot/proc /newroot/sys
        /bin/busybox mount --move /dev /newroot/dev
        /bin/busybox mount -t proc proc /newroot/proc
        /bin/busybox mount -t sysfs sysfs /newroot/sys

        exec /bin/busybox switch_root /newroot /init
        EOF
        chmod 0755 root/init

        cd root
        mkdir -p $out
        find . | cpio -H newc -o > $out/initramfs.cpio
        gzip -c $out/initramfs.cpio > $out/initramfs.cpio.gz
      '';
    };

  runnerApp = pkgs.buildNpmPackage {
    pname = "vm-test-runner-app";
    version = "0.0.0";
    src = ../..;
    npmDepsHash = "sha256-TaNxUnhnxv2Q4p/IfiYFMwx9+EI3aVsG05WUOoJdGwI=";
    dontNpmBuild = true;

    preBuild = ''
      export npm_config_cache=$TMPDIR/npm-cache
      mkdir -p "$npm_config_cache"
      npm install --no-save --ignore-scripts ${linux}/linux.tgz
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp packages/vm-test/src/run-test.ts $out/run-test.ts
      cat > $out/package.json <<'EOF'
      {
        "type": "module",
        "dependencies": {
          "@tombl/linux": "0.0.0"
        }
      }
      EOF
      mkdir -p $out/node_modules/@tombl
      cp -RL node_modules/@tombl/linux $out/node_modules/@tombl/linux

      runHook postInstall
    '';
  };

  vmTest =
    {
      name,
      rootfs ? { },
      script,
      memoryMib ? 128,
      cpus ? 1,
      timeoutSeconds ? 30,
      cmdline ? "",
      baseBusybox ? busybox,
    }:
    let
      image = mkRootfs (
        rootfs
        // {
          inherit name;
          contents = (rootfs.contents or [ ]) ++ [ baseBusybox ];
          init = ''
            #!/bin/busybox sh

            PATH=/bin:/sbin:/usr/bin:/usr/sbin
            export PATH

            echo "@@TEST-START ${name}"
            set +e
            (
              set -e
            ${lib.pipe script [
              (lib.splitString "\n")
              (map (line: "  " + line))
              (lib.concatStringsSep "\n")
            ]}
            )
            status=$?
            if [ "$status" -eq 0 ]; then
              echo "@@TEST-PASS"
            else
              echo "@@TEST-FAIL status=$status"
            fi

            sync
            poweroff -f
            reboot -f
            while true; do sleep 86400; done
          '';
        }
      );
    in
    pkgs.runCommand "vm-test-${name}"
      {
        nativeBuildInputs = [ pkgs.deno ];
      }
      ''
        export HOME="$TMPDIR/home"
        export DENO_DIR="$TMPDIR/deno"
        mkdir -p "$HOME" "$DENO_DIR"

        disk="$TMPDIR/rootfs.ext4"
        cp ${image}/rootfs.ext4 "$disk"
        chmod u+w "$disk"

        ${lib.getExe pkgs.deno} run --allow-all ${runnerApp}/run-test.ts \
          --initcpio ${mkTestInitramfs baseBusybox}/initramfs.cpio \
          --disk "$disk" \
          --memory ${lib.escapeShellArg (toString memoryMib)} \
          --cpus ${lib.escapeShellArg (toString cpus)} \
          --timeout ${lib.escapeShellArg (toString timeoutSeconds)} \
          --cmdline ${lib.escapeShellArg cmdline}

        mkdir -p "$out"
        printf 'passed\n' > "$out/result"
      '';
in
{
  inherit
    runnerApp
    vmTest
    ;
  testInitramfs = mkTestInitramfs busybox;
}
