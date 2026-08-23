{
  bootMode,
  bytes,
  kernel,
  linux-guest,
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
    pkgs.nodejs
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  buildPhase = ''
    runHook preBuild

    cp -r ${bytes}/dist packages/bytes/dist
    cp -r ${kernel}/dist packages/kernel/dist
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -r ${linux-guest.package}/dist packages/linux-guest/dist
    cp ${linux-guest.package}/agent.img packages/linux-guest/agent.img

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
