{
  callPackage,
  linux,
}:

let
  agentInitramfs = callPackage ./agent.nix { };
  # The canonical system image that lowland/image attaches.
  rootfs = callPackage ./rootfs.nix { };
  builderImage = callPackage ./builder.nix { };

  # The files the package loads relative to its modules, from assets/, by
  # role. Each name must match the `new URL("../../assets/…")` that loads it
  # in packages/lowland/src, and nothing else names them.
  assets = {
    kernel = {
      name = "vmlinux.wasm";
      path = "${linux}/vmlinux.wasm";
    };
    agent = {
      name = "agent.cpio";
      path = agentInitramfs;
    };
    rootfs = {
      name = "rootfs.erofs";
      path = rootfs;
    };
    builder = {
      name = "builder.erofs";
      path = builderImage;
    };
  };

  packages = callPackage ./package.nix {
    inherit assets;
    # A writable copy of the canonical system for the image tests.
    canonicalExt4 = callPackage ./rootfs.nix {
      format = "ext4";
      size = "64M";
    };
  };
in
{
  inherit (packages) dist machine package;
  inherit
    agentInitramfs
    assets
    builderImage
    rootfs
    ;
  # Root images for the guest tests; see ../test-assets.nix.
  testImages = {
    rootfs = callPackage ./test-rootfs.nix { };
    ext4Root = callPackage ./test-rootfs.nix {
      format = "ext4";
      size = "64M";
    };
  };
  recurseForDerivations = true;
}
