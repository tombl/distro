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
    cp packages/kernel/package.json $out/package.json
    cp packages/kernel/README.md $out/README.md
    cp packages/kernel/LICENSE $out/LICENSE
    cp packages/kernel/vmlinux.wasm $out/vmlinux.wasm
    cp -r packages/kernel/dist $out/dist
    node scripts/pack-package.mjs packages/kernel --out $out/kernel.tgz

    runHook postInstall
  '';
}
