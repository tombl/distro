{
  installedFiles,
  pkgs,
  sourceVersion,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "lowland-boot";
  # APK upgrades need monotonic versions. Immutable assets retain their
  # derivation-addressed directory independently of this package version.
  version = "0.${sourceVersion}";
  dontUnpack = true;

  installPhase = ''
    mkdir -p $out/boot $out/etc/apk/protected_paths.d
    cp -r ${installedFiles}/. $out/boot/
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
