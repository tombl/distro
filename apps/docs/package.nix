{
  bytes,
  kernel,
  linux-guest,
  lowland-image,
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

    cp -r ${bytes}/dist packages/bytes/dist
    cp -r ${kernel}/dist packages/kernel/dist
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    # Runnable examples serve the packages and their artifacts from the site.
    cp ${linux-guest.package}/agent.cpio packages/linux-guest/agent.cpio
    cp ${lowland-image.rootfs} packages/image/rootfs.erofs
    cp ${lowland-image.builderImage} packages/image/builder.erofs
    pnpm --filter=@lowland/guest build
    pnpm --filter=@lowland/image build
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
