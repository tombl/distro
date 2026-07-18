{
  pkgs,
  guest-initramfs,
  guest-rootfs,
  linux,
  stdenv,
}:

let
  network-test = stdenv.mkDerivation {
    pname = "linux-guest-network-test";
    version = "0.0.0";
    dontUnpack = true;
    buildPhase = ''
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -Wl,--fatal-warnings -o network-test ${./network-test.c}
    '';
    installPhase = ''
      mkdir -p $out/bin
      cp network-test $out/bin/
    '';
  };

  package = pkgs.buildNpmPackage {
    pname = "linux-guest";
    version = "0.0.0";
    src = ../..;
    npmDepsHash = "sha256-2tX0XR24dREbZOXaCmjho9i6+0J7K4anv2Zj2fbLAzc=";
    npmBuildFlags = [ "--workspace=@tombl/linux-guest" ];

    preBuild = ''
      export npm_config_cache=$TMPDIR/npm-cache
      mkdir -p "$npm_config_cache"
      npm install --no-save --ignore-scripts ${linux}/linux.tgz
      npm run check --workspace=@tombl/linux-guest
    '';

    postBuild = ''
      rootfs_size=$(stat --format=%s ${guest-rootfs})
      substituteInPlace packages/linux-guest/dist/assets.js \
        --replace-fail '@ROOTFS_SIZE@' "$rootfs_size"
      cp ${guest-initramfs} packages/linux-guest/initramfs.cpio
      cp ${guest-rootfs} packages/linux-guest/rootfs.squashfs
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp packages/linux-guest/package.json $out/package.json
      cp packages/linux-guest/initramfs.cpio $out/initramfs.cpio
      cp packages/linux-guest/rootfs.squashfs $out/rootfs.squashfs
      cp -r packages/linux-guest/dist $out/dist
      npm pack ./packages/linux-guest --pack-destination $out
      mv $out/tombl-linux-guest-*.tgz $out/linux-guest.tgz

      runHook postInstall
    '';
  };

  integration =
    pkgs.runCommand "linux-guest-integration-test"
      {
        nativeBuildInputs = [
          pkgs.deno
          pkgs.gnutar
        ];
      }
      ''
        export HOME=$TMPDIR/home
        export DENO_DIR=$TMPDIR/deno
        test_root=$TMPDIR/test
        mkdir -p "$HOME" "$DENO_DIR" "$test_root/node_modules/@tombl/linux"
        cp -r ${package} "$test_root/node_modules/@tombl/linux-guest"
        tar -xzf ${linux}/linux.tgz --strip-components=1 \
          -C "$test_root/node_modules/@tombl/linux"
        cp ${./integration-consumer.json} "$test_root/package.json"
        cp ${./integration-test.ts} "$test_root/integration-test.ts"
        cp ${network-test}/bin/network-test "$test_root/network-test"
        cd "$test_root"
        timeout 180 deno run --allow-all integration-test.ts \
          node_modules/@tombl/linux-guest/dist/index.js network-test
        mkdir $out
      '';
in
package
// {
  checks.integration = integration;
}
