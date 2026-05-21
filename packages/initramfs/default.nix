{ pkgs }:

pkgs.stdenvNoCC.mkDerivation {
  name = "initramfs.cpio";
  src = ./.;
  nativeBuildInputs = [
    pkgs.cpio
    pkgs.gzip
  ];
  buildPhase = ''
    runHook preBuild

    mkdir -p root/bin root/usr/bin root/sbin root/usr/sbin
    cp init.sh root/init
    chmod +x root/init
    cp ${pkgs.wasmpkgs.busybox}/bin/busybox root/bin/busybox

    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall

    cd root
    mkdir -p $out
    find . | cpio -H newc -o > $out/initramfs.cpio
    gzip -c $out/initramfs.cpio > $out/initramfs.cpio.gz

    runHook postInstall
  '';
}
