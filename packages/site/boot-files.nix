{
  pkgs,
  linux,
  linux-guest,
}:

let
  sourceHash = builtins.hashFile "sha256" ./index.html;
  ver = builtins.substring 0 16 (
    builtins.hashString "sha256" "${linux}${linux-guest.package}${sourceHash}"
  );
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-boot";
  # Deliberately bump this when publishing a new boot package. The immutable
  # asset directory remains content-derived independently of the APK version.
  version = "0.1.0";
  dontUnpack = true;

  installPhase = ''
    mkdir -p $out/boot/static/v${ver} $out/boot/vendor $out/usr/share/lowland-boot
    cp -rL ${linux}/dist $out/boot/static/v${ver}/dist
    cp -L ${linux}/vmlinux.wasm $out/boot/static/v${ver}/vmlinux.wasm
    cp -rL ${linux-guest.package}/dist $out/boot/static/v${ver}/guest
    cp -r ${./vendor}/. $out/boot/vendor/
    cp ${./index.html} $out/usr/share/lowland-boot/index.html
    substituteInPlace $out/usr/share/lowland-boot/index.html \
      --replace-fail __ASSETS__ v${ver} \
      --replace-fail __BOOT_MODE__ installed
  '';

  passthru.apk = {
    depends = [ "busybox" ];
    scripts.post-install = ./boot-post-install.sh;
  };
}
