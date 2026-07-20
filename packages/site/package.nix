{
  image,
  pkgs,
  linux,
  node-workspace,
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
    gzip --best --no-name --stdout ${image}/initramfs.cpio > $out/initramfs.cpio.gz
    gzip --best --no-name --stdout ${image}/rootfs.squashfs > $out/rootfs.squashfs.gz

    # The hosting provider rejects individual assets larger than 25 MB. Keep
    # this product constraint next to the artifact rather than relying on a
    # comment in the rootfs package list.
    rootfs_bytes=$(wc -c < $out/rootfs.squashfs.gz)
    if [ "$rootfs_bytes" -gt 25000000 ]; then
      echo "site rootfs is $rootfs_bytes bytes; hosting limit is 25000000" >&2
      exit 1
    fi

    runHook postInstall
  '';
}
