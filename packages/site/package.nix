{
  run,
  linux,
  initramfs,
}:

run
  {
    name = "site";
    src = "${linux.src}/tools/wasm";
  }
  ''
    mkdir $out
    cp -r run.js public/* src $out/
    ln -s ${initramfs} $out/initramfs.cpio
    ln -sf ${linux} $out/dist
  ''
