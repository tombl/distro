{
  bytes,
  kernel,
  pkgs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "opfs-disk-worker";
  version = "0.0.0";
  dontUnpack = true;
  nativeBuildInputs = [ pkgs.esbuild ];

  installPhase = ''
    mkdir -p node_modules/@lowland $out
    ln -s ${bytes} node_modules/@lowland/bytes
    esbuild ${../../apps/site/opfs-disk-worker.js} \
      --bundle \
      --format=esm \
      --minify \
      --alias:@lowland/kernel/virtio/block.js=${kernel}/dist/virtio/block.js \
      --alias:@lowland/kernel/virtio/remote.js=${kernel}/dist/virtio/remote.js \
      --outfile=$out/opfs-disk-worker.js
  '';
}
