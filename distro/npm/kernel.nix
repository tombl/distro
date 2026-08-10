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
    cp -r ${bytes}/dist packages/bytes/dist
    pnpm --filter=@lowland/kernel check
    pnpm --filter=@lowland/kernel test
    pnpm --filter=@lowland/kernel build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/node_modules/@lowland/bytes
    cp packages/kernel/package.json $out/package.json
    cp packages/kernel/README.md $out/README.md
    cp packages/kernel/LICENSE $out/LICENSE
    cp packages/kernel/vmlinux.wasm $out/vmlinux.wasm
    cp -r packages/kernel/dist $out/dist
    cp packages/bytes/package.json $out/node_modules/@lowland/bytes/package.json
    cp packages/bytes/README.md $out/node_modules/@lowland/bytes/README.md
    cp packages/bytes/LICENSE $out/node_modules/@lowland/bytes/LICENSE
    cp -r packages/bytes/dist $out/node_modules/@lowland/bytes/dist
    npm pack ./packages/kernel --pack-destination $out
    mv $out/lowland-kernel-*.tgz $out/kernel.tgz

    runHook postInstall
  '';
}
