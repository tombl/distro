{
  pkgs,
  linux,
  linux-guest,
  sourceVersion,
}:

let
  sourceHash = builtins.hashFile "sha256" ./index.html;
  ver = builtins.substring 0 16 (
    builtins.hashString "sha256" "${linux}${linux-guest.package}${sourceHash}"
  );
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-boot";
  # APK upgrades require versions to increase, which a content hash cannot
  # guarantee. The flake source's commit timestamp is reproducible for a
  # commit and monotonic across published builds; immutable asset paths remain
  # content-derived independently below.
  version = "0.${sourceVersion}";
  dontUnpack = true;

  installPhase = ''
    mkdir -p $out/boot/static/v${ver} $out/boot/vendor $out/etc/apk/protected_paths.d
    cp -rL ${linux}/dist $out/boot/static/v${ver}/dist
    cp -L ${linux}/vmlinux.wasm $out/boot/static/v${ver}/vmlinux.wasm
    cp -rL ${linux-guest.package}/dist $out/boot/static/v${ver}/guest
    cp -r ${./vendor}/. $out/boot/vendor/
    cp ${./index.html} $out/boot/index.html
    substituteInPlace $out/boot/index.html \
      --replace-fail __ASSETS__ v${ver} \
      --replace-fail __BOOT_MODE__ installed
    printf '%s\n' '+boot/index.html' > $out/etc/apk/protected_paths.d/lowland-boot.list
  '';

  passthru.apk = {
    depends = [ "busybox" ];
  };
}
