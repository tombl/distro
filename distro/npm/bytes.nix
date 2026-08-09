{
  node-workspace,
  pkgs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-bytes";
  inherit ((builtins.fromJSON (builtins.readFile ../../packages/bytes/package.json))) version;
  src = ../..;
  env.CI = "true";
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs
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
    cp packages/bytes/package.json $out/package.json
    cp packages/bytes/README.md $out/README.md
    cp packages/bytes/LICENSE $out/LICENSE
    cp -r packages/bytes/dist $out/dist
    pnpm --filter=@lowland/bytes pack --pack-destination $out
    mv $out/lowland-bytes-*.tgz $out/bytes.tgz

    runHook postInstall
  '';
}
