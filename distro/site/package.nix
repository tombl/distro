{
  liveFiles,
  pkgs,
  rootfs,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "site";
  version = "0.0.0";
  dontUnpack = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp -r ${liveFiles}/. $out/

    # The EROFS image is immutable and served under its content hash. Its
    # manifest lets the browser range-stream it into the block device.
    sha=$(${pkgs.openssl}/bin/openssl dgst -sha256 -r ${rootfs} | awk '{ print $1 }')
    cp ${rootfs} $out/rootfs-''${sha}.erofs
    size=$(wc -c < ${rootfs})
    printf '{"sha":"%s","size":%s}' "$sha" "$size" > $out/rootfs.erofs.json

    cp ${../../apps/site/service-worker.js} $out/service-worker.js
    cp ${../../apps/site/_headers} $out/_headers
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
