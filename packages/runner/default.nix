{
  callPackage,
  image,
}:

let
  rootfs = callPackage ./rootfs.nix { };
  bundle = image.mkBundle {
    name = "runner-image";
    initramfs = image.bootInitramfs;
    inherit rootfs;
  };
in
{
  package = callPackage ./package.nix { image = bundle; };
  image = bundle;
  recurseForDerivations = true;
}
