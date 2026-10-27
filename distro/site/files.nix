{
  bootMode,
  lowland,
  node-workspace,
  pkgs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "site-files-${bootMode}";
  version = "0.0.0";
  src = ../..;
  env = {
    CI = "true";
    PUBLIC_BOOT_MODE = bootMode;
  };
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs_26
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  buildPhase = ''
    runHook preBuild

    ${node-workspace.installBuilt {
      lowland = lowland.dist;
      assets = [
        lowland.assets.kernel
        lowland.assets.agent
      ];
    }}

    pnpm --filter=@lowland/site check
    pnpm --filter=@lowland/site build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -r apps/site/dist/. $out/

    runHook postInstall
  '';
}
