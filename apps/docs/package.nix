{
  bytes,
  kernel,
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
    pkgs.nodejs
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  buildPhase = ''
    runHook preBuild

    cp -r ${bytes}/dist packages/bytes/dist
    cp -r ${kernel}/dist packages/kernel/dist
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    pnpm --filter=@lowland/guest build
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
