{
  pkgs,
  initramfs,
  linux,
  rootfs,
}:

pkgs.buildNpmPackage {
  pname = "site";
  version = "0.0.0";
  src = ../..;
  npmDepsHash = "sha256-WZWwNHVFjZLBhCqd10XP7rLYTXGOtEG2TgpFyUF1qS8=";
  npmBuildFlags = [ "--workspace=@tombl/linux-site" ];
  nativeBuildInputs = [ pkgs.gzip ];

  preBuild = ''
    export npm_config_cache=$TMPDIR/npm-cache
    mkdir -p "$npm_config_cache"
    npm install --no-save --ignore-scripts ${linux}/linux.tgz
    npm run check --workspace=@tombl/linux-site
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -r packages/site/dist/* $out/
    gzip --best --no-name --stdout ${initramfs} > $out/initramfs.cpio.gz
    gzip --best --no-name --stdout ${rootfs} > $out/rootfs.ext4.gz

    runHook postInstall
  '';
}
