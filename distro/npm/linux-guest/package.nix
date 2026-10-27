{
  agentInitramfs,
  bytes,
  pkgs,
  kernel,
  node-workspace,
  test-assets,
}:

let
  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "linux-guest";
    inherit ((builtins.fromJSON (builtins.readFile ../../../packages/linux-guest/package.json)))
      version
      ;
    src = node-workspace.source [
      "packages/bytes"
      "packages/kernel"
      "packages/linux-guest/src"
      "packages/linux-guest/tsconfig.json"
      "packages/linux-guest/README.md"
      "packages/linux-guest/LICENSE"
      "scripts/pack-package.mjs"
      "scripts/packages.mjs"
      "tsconfig.base.json"
    ];
    env.CI = "true";
    pnpmDeps = node-workspace.deps;
    nativeBuildInputs = [
      pkgs.nodejs_26
      pkgs.pnpmConfigHook
      node-workspace.pnpm
    ];

    buildPhase = ''
      runHook preBuild

      ${node-workspace.installBuilt { inherit bytes kernel; }}
      cp ${agentInitramfs} packages/linux-guest/agent.cpio
      pnpm --filter=@lowland/guest build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      node scripts/pack-package.mjs packages/linux-guest --out $out/package.tgz
      tar -xzf $out/package.tgz --strip-components=1 -C $out

      runHook postInstall
    '';
  };

  integration = node-workspace.mkTest {
    name = "linux-guest-integration-test";
    paths = [ "packages/linux-guest" ];
    built = { inherit bytes kernel; };
    assets = test-assets.select [
      "boot.cpio"
      "getdents-inode"
      "lifecycle.erofs"
      "network-test"
      "rootfs.erofs"
      "rootfs.ext4"
      "user-trap"
    ];
    command = ''
      cp ${agentInitramfs} packages/linux-guest/agent.cpio
      pnpm --filter=@lowland/guest check
      timeout --kill-after=5 300 pnpm --filter=@lowland/guest test
    '';
  };
in
package
// {
  checks.tests.integration = integration;
}
