{
  pkgs,
  initramfs,
  linux,
  node-workspace,
  rootfs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "site";
  version = "0.0.0";
  src = ../..;
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.gzip
    pkgs.nodejs
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];

  buildPhase = ''
    runHook preBuild

    mkdir -p checkouts/linux/tools/wasm
    tar -xzf ${linux}/linux.tgz --strip-components=1 -C checkouts/linux/tools/wasm

    pnpm --filter=@tombl/linux-guest build
    pnpm --filter=@tombl/linux-site check
    pnpm --filter=@tombl/linux-site build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -r packages/site/dist/* $out/
    gzip --best --no-name --stdout ${initramfs} > $out/initramfs.cpio.gz
    gzip --best --no-name --stdout ${rootfs} > $out/rootfs.ext4.gz

    runHook postInstall
  '';
}
