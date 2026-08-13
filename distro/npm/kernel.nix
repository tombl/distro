{
  bytes,
  linux,
  node-workspace,
  pkgs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-kernel";
  inherit ((builtins.fromJSON (builtins.readFile ../../packages/kernel/package.json))) version;
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

    cp ${linux}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -rT ${bytes}/dist packages/bytes/dist
    pnpm --filter=@lowland/kernel check
    pnpm --filter=@lowland/kernel test
    pnpm --filter=@lowland/kernel build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    node scripts/pack-package.mjs packages/kernel --out $out/package.tgz
    tar -xzf $out/package.tgz --strip-components=1 -C $out

    runHook postInstall
  '';
}
