{
  bytes,
  pkgs,
  kernel,
  linux-guest,
  sourceVersion,
}:

let
  sourceHash = builtins.hashFile "sha256" ../../apps/site/index.html;
  ver = builtins.substring 0 16 (
    builtins.hashString "sha256" "${bytes}${kernel}${linux-guest.package}${sourceHash}"
  );
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-boot";
  # APK upgrades need monotonic versions. Immutable heavy assets retain their
  # content-derived directory independently of this package version.
  version = "0.${sourceVersion}";
  dontUnpack = true;

  installPhase = ''
    mkdir -p $out/boot/static/v${ver} $out/boot/vendor $out/etc/apk/protected_paths.d
    cp -rL ${kernel}/dist $out/boot/static/v${ver}/dist
    cp -L ${kernel}/vmlinux.wasm $out/boot/static/v${ver}/vmlinux.wasm
    cp -rL ${bytes}/dist $out/boot/static/v${ver}/bytes
    cp -rL ${linux-guest.package}/dist $out/boot/static/v${ver}/guest
    cp -L ${linux-guest.package}/agent.erofs $out/boot/static/v${ver}/agent.erofs
    cp -r ${../../apps/site/vendor}/. $out/boot/vendor/
    cp ${../../apps/site/index.html} $out/boot/index.html
    substituteInPlace $out/boot/index.html \
      --replace-fail __ASSETS__ v${ver} \
      --replace-fail __BOOT_MODE__ installed
    # apk applies protection rules at directory granularity when deciding
    # whether a package file is locally modified. Protect the boot tree so a
    # deployment upgrade writes an administrator-edited file as .apk-new
    # instead of replacing the installed site's customization.
    printf '%s\n' '+boot/' > $out/etc/apk/protected_paths.d/lowland-boot.list
  '';

  passthru.apk = {
    depends = [ "busybox" ];
  };
}
