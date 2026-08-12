{
  assets,
  pkgs,
  rootfs,
}:

let
  # The Nix store hash covers the bundle's builder and all referenced inputs.
  assetVersion = "v${builtins.substring 0 32 (builtins.baseNameOf assets)}";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "site";
  version = "0.0.0";
  src = ../../apps/site;

  installPhase = ''
    runHook preInstall

    # A single _headers splat (/* is greedy across slashes, and only one splat
    # is allowed per rule) can mark the derivation-addressed bundle immutable.
    mkdir -p $out/static/${assetVersion}
    cp -rL ${assets}/. $out/static/${assetVersion}/

    # The EROFS image is immutable and served under its content hash. Its
    # manifest lets the browser range-stream it into the block device.
    sha=$(${pkgs.openssl}/bin/openssl dgst -sha256 -r ${rootfs} | awk '{ print $1 }')
    cp ${rootfs} $out/rootfs-''${sha}.erofs
    size=$(wc -c < ${rootfs})
    printf '{"sha":"%s","size":%s}' "$sha" "$size" > $out/rootfs.erofs.json

    mkdir -p $out
    substituteInPlace index.html \
      --replace-fail __ASSETS__ ${assetVersion} \
      --replace-fail __BOOT_MODE__ live
    cp index.html $out/index.html
    cp service-worker.js $out/service-worker.js
    cp _headers $out/_headers
    cp -r vendor $out/vendor
    # The hosting provider rejects individual assets larger than 25 MB.
    rootfs_bytes=$(wc -c < $out/rootfs-''${sha}.erofs)
    if [ "$rootfs_bytes" -gt 25000000 ]; then
      echo "site rootfs is $rootfs_bytes bytes; hosting limit is 25000000" >&2
      exit 1
    fi

    runHook postInstall
  '';
  passthru = { inherit rootfs; };
}
