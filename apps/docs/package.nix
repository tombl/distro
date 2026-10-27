{
  lib,
  lowland,
  node-workspace,
  pkgs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "docs";
  version = "0.0.0";
  src = ../..;
  env.CI = "true";
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs_26
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  buildPhase = ''
    runHook preBuild

    # Runnable examples serve the package and its assets from the site.
    ${node-workspace.installBuilt {
      lowland = lowland.dist;
      assets = lib.attrValues lowland.assets;
    }}
    pnpm --filter=@lowland/docs check
    pnpm --filter=@lowland/docs build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -r apps/docs/dist/. $out/

    runHook postInstall
  '';
}
