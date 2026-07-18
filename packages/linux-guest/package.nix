{
  pkgs,
  guest-initramfs,
  guest-rootfs,
  linux,
  stdenv,
}:

let
  npmDepsHash = "sha256-1NL9O4LvSzJMl9QLJytT5VyYyiSJecsilr26fPOw/A4=";

  network-test = stdenv.mkDerivation {
    pname = "linux-guest-network-test";
    version = "0.0.0";
    dontUnpack = true;
    buildPhase = ''
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -Wl,--fatal-warnings -o network-test ${./tests/network-test.c}
    '';
    installPhase = ''
      mkdir -p $out/bin
      cp network-test $out/bin/
    '';
  };

  # The directory layout tests/assets.ts consumes, via LINUX_GUEST_TEST_ASSETS
  # or by building this attribute itself.
  test-assets = pkgs.linkFarm "linux-guest-test-assets" {
    "initramfs.cpio" = guest-initramfs;
    "rootfs.squashfs" = guest-rootfs;
    "network-test" = "${network-test}/bin/network-test";
  };

  package = pkgs.buildNpmPackage {
    pname = "linux-guest";
    version = "0.0.0";
    src = ../..;
    inherit npmDepsHash;
    npmBuildFlags = [ "--workspace=@tombl/linux-guest" ];

    preBuild = ''
      export npm_config_cache=$TMPDIR/npm-cache
      mkdir -p "$npm_config_cache"
      npm install --no-save --ignore-scripts ${linux}/linux.tgz
      npm run check --workspace=@tombl/linux-guest
    '';

    postBuild = ''
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

  integration = pkgs.buildNpmPackage {
    pname = "linux-guest-integration-test";
    version = "0.0.0";
    src = ../..;
    inherit npmDepsHash;
    nativeBuildInputs = [ pkgs.nodejs ];

    buildPhase = ''
      runHook preBuild

      export npm_config_cache=$TMPDIR/npm-cache
      mkdir -p "$npm_config_cache"
      npm install --no-save --ignore-scripts ${linux}/linux.tgz
      npm run check --workspace=@tombl/linux-guest-tests

      LINUX_GUEST_TEST_ASSETS=${test-assets} \
        timeout 180 npm run test --workspace=@tombl/linux-guest-tests

      runHook postBuild
    '';

    installPhase = ''
      mkdir $out
    '';
  };
in
package
// {
  checks.tests = {
    assets = test-assets;
    inherit integration;
  };
}
