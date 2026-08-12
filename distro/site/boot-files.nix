{
  assets,
  pkgs,
  sourceVersion,
}:

let
  assetVersion = "v${builtins.substring 0 32 (builtins.baseNameOf assets)}";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-boot";
  # APK upgrades need monotonic versions. Immutable assets retain their
  # derivation-addressed directory independently of this package version.
  version = "0.${sourceVersion}";
  dontUnpack = true;

  installPhase = ''
    mkdir -p $out/boot/static/${assetVersion} $out/boot/vendor $out/etc/apk/protected_paths.d
    cp -rL ${assets}/. $out/boot/static/${assetVersion}/
    cp -r ${../../apps/site/vendor}/. $out/boot/vendor/
    cp ${../../apps/site/index.html} $out/boot/index.html
    substituteInPlace $out/boot/index.html \
      --replace-fail __ASSETS__ ${assetVersion} \
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
