{
  bridge-site,
  bytes,
  pkgs,
  kernel,
  linux-guest,
  opfsDiskWorker,
}:

pkgs.runCommand "site-assets" { } ''
  mkdir -p $out
  # dist/index.js loads vmlinux.wasm relative to itself (../vmlinux.wasm),
  # so the kernel library and kernel sit as siblings inside the bundle.
  cp -rL ${kernel}/dist $out/dist
  cp -L ${kernel}/vmlinux.wasm $out/vmlinux.wasm
  cp -rL ${bytes}/dist $out/bytes
  cp -rL ${linux-guest.package}/dist $out/guest
  cp -L ${linux-guest.package}/agent.erofs $out/agent.erofs
  cp ${bridge-site.package.client} $out/bridge-client.js
  cp ${opfsDiskWorker}/opfs-disk-worker.js $out/opfs-disk-worker.js
''
