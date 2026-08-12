{
  assets,
  bootMode,
  pkgs,
}:

let
  # The store hash identifies the bundle's builder and all referenced inputs.
  assetDirectory = builtins.substring 0 32 (builtins.baseNameOf assets);
in
pkgs.runCommand "site-files-${bootMode}" { } ''
  mkdir -p $out/static/${assetDirectory}
  cp -rL ${assets}/. $out/static/${assetDirectory}/
  cp -r ${../../apps/site/vendor} $out/vendor
  cp ${../../apps/site/index.html} $out/index.html
  substituteInPlace $out/index.html \
    --replace-fail __ASSET_DIRECTORY__ ${assetDirectory} \
    --replace-fail __BOOT_MODE__ ${bootMode}
''
