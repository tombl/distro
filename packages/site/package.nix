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

  # The kernel assets are content-stable per build but served under fixed
  # names, so they are cached immutable under a build-versioned directory:
  # a new build changes the version and every URL, so browsers never revalidate
  # the heavy kernel libraries across the guest's many workers. The version
  # tracks the kernel, the guest SDK, and the rootfs.
  ver = builtins.substring 0 16 (
    builtins.hashString "sha256" "${linux}${linux-guest.package}${rootfs}"
  );
in

pkgs.stdenvNoCC.mkDerivation {
  pname = "site";
  version = "0.0.0";
  src = ./.;

  installPhase = ''
    runHook preInstall

    # The kernel assets sit under a fixed /static/ prefix with a per-build
    # version directory, so a single _headers splat (/* is greedy across
    # slashes, and only one splat is allowed per rule) can mark them immutable.
    mkdir -p $out/static/v${ver}
    # dist/index.js loads vmlinux.wasm relative to itself (../vmlinux.wasm),
    # so the kernel library and kernel sit as siblings inside the versioned
    # directory, exactly as the linux package lays them out.
    cp -rL ${linux}/dist $out/static/v${ver}/dist
    cp -L ${linux}/vmlinux.wasm $out/static/v${ver}/vmlinux.wasm
    cp -rL ${linux-guest.package}/dist $out/static/v${ver}/guest

    # The rootfs is served under its own content hash so the seed can be
    # cached immutable too; the page learns the name from rootfs.ext4.sha256.
    sha=$(${pkgs.openssl}/bin/openssl dgst -sha256 -r ${rootfs} | awk '{ print $1 }')
    gzip --best --no-name --stdout ${rootfs} > $out/rootfs-''${sha}.ext4.gz
    printf '%s' "$sha" > $out/rootfs.ext4.sha256

    mkdir -p $out
    substituteInPlace index.html --replace-fail __ASSETS__ v${ver}
    cp index.html $out/index.html
    cp _headers $out/_headers
    cp repo.json $out/repo.json
    cp -r vendor $out/vendor
    ln -s ${initramfs} $out/initramfs.cpio

    # The hosting provider rejects individual assets larger than 25 MB.
    rootfs_bytes=$(wc -c < $out/rootfs-''${sha}.ext4.gz)
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
