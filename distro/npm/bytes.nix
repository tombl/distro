{
  node-workspace,
  pkgs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-bytes";
  inherit ((builtins.fromJSON (builtins.readFile ../../packages/bytes/package.json))) version;
  src = node-workspace.source [
    "tsconfig.base.json"
    "packages/bytes"
    "scripts/pack-package.mjs"
    "scripts/packages.mjs"
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

    pnpm --filter=@lowland/bytes check
    pnpm --filter=@lowland/bytes build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    node scripts/pack-package.mjs packages/bytes --out $out/package.tgz
    tar -xzf $out/package.tgz --strip-components=1 -C $out

    runHook postInstall
  '';
}
