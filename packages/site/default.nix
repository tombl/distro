{ pkgs }:

let
  inherit (pkgs.wasmpkgs)
    initramfs
    linux
    rootfs
    ;
in

pkgs.buildNpmPackage {
  pname = "site";
  version = "0.0.0";
  src = ../..;
  npmDepsHash = "sha256-TaNxUnhnxv2Q4p/IfiYFMwx9+EI3aVsG05WUOoJdGwI=";
  npmBuildFlags = [ "--workspace=@tombl/linux-site" ];

  preBuild = ''
    export npm_config_cache=$TMPDIR/npm-cache
    mkdir -p "$npm_config_cache"
    npm install --no-save --ignore-scripts ${linux}/linux.tgz
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -r packages/site/dist/* $out/
    ln -s ${initramfs}/initramfs.cpio.gz $out/
    ln -s ${rootfs}/rootfs.ext4.gz $out/

    runHook postInstall
  '';
}
