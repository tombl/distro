{
  description = "A program ported to Linux on WebAssembly";

  inputs.lowland.url = "github:tombl/distro";

  nixConfig = {
    extra-substituters = [ "https://linuxwasm.cachix.org" ];
    extra-trusted-public-keys = [
      "linuxwasm.cachix.org-1:+z2SehaESo/3sYp7afTgyXBHUkSj/Y+BokzAkWZEmeM="
    ];
  };

  outputs =
    { lowland, ... }:
    let
      # The guest packages are built by Linux build platforms. macOS delegates
      # these builds to a Linux builder rather than naming its own systems.
      eachSystem = lowland.inputs.nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      packages = eachSystem (
        system:
        let
          # The wasm package scope: its stdenv targets the guest, and its
          # packages are the ones an image can install.
          wasmpkgs = lowland.legacyPackages.${system};
          hello = wasmpkgs.callPackage ./package.nix { };
        in
        {
          inherit hello;
          image = wasmpkgs.mkImage {
            name = "hello";
            packages = [
              wasmpkgs.busybox
              hello
            ];
          };
          default = hello;
        }
      );
    };
}
