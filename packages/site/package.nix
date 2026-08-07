{
  pkgs,
  busybox,
  image,
  linux,
  linux-guest,
  rootfs,
}:

let
  initramfs = image.mkInitramfs {
    name = "site-boot-initramfs";
    init = ./boot-init.sh;
    contents = [ busybox ];
  };
in

pkgs.stdenvNoCC.mkDerivation {
  pname = "site";
  version = "0.0.0";
  src = ./.;

  # dist/ and vmlinux.wasm are the wasm kernel host library and kernel. The
  # library loads vmlinux.wasm relative to itself (dist/index.js -> ../vmlinux.wasm),
  # so they sit as siblings, exactly as the linux package lays them out. The
  # guest SDK (linux-guest) ships alongside for the browser-side network
  # adapters, and the page imports both through an import map. The apk repo is
  # not served here: the publish script signs it and uploads it to R2, and the
  # page learns that URL from repo.json.
  installPhase = ''
    runHook preInstall

    mkdir -p $out
    cp index.html $out/index.html
    cp _headers $out/_headers
    cp repo.json $out/repo.json
    cp -r vendor $out/vendor
    ln -s ${linux}/dist $out/dist
    ln -s ${linux}/vmlinux.wasm $out/vmlinux.wasm
    ln -s ${linux-guest.package}/dist $out/guest
    ln -s ${initramfs} $out/initramfs.cpio
    gzip --best --no-name --stdout ${rootfs} > $out/rootfs.ext4.gz
    ${pkgs.openssl}/bin/openssl dgst -sha256 -r ${rootfs} \
      | awk '{ print $1 }' > $out/rootfs.ext4.sha256

    # The hosting provider rejects individual assets larger than 25 MB.
    rootfs_bytes=$(wc -c < $out/rootfs.ext4.gz)
    if [ "$rootfs_bytes" -gt 25000000 ]; then
      echo "site rootfs is $rootfs_bytes bytes; hosting limit is 25000000" >&2
      exit 1
    fi

    runHook postInstall
  '';
  passthru = {
    inherit
      initramfs
      rootfs
      ;
  };
}
