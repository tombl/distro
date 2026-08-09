{
  pkgs,
  linux,
  linux-guest,
  installDisk,
  installerRepository,
  rootfs,
}:

let
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

    # SquashFS is already block-compressed. Serve it directly under a content
    # hash so the browser can lazily range-read it and cache those ranges.
    sha=$(${pkgs.openssl}/bin/openssl dgst -sha256 -r ${rootfs} | awk '{ print $1 }')
    cp ${rootfs} $out/rootfs-''${sha}.squashfs
    size=$(wc -c < ${rootfs})
    printf '{"sha":"%s","size":%s}' "$sha" "$size" > $out/rootfs.squashfs.json

    # The persistent disk starts as a blank ext4 filesystem. It is tiny when
    # compressed despite its 64 MiB logical size, and is only fetched once.
    install_sha=$(${pkgs.openssl}/bin/openssl dgst -sha256 -r ${installDisk} | awk '{ print $1 }')
    gzip --best --no-name --stdout ${installDisk} > $out/install-''${install_sha}.ext4.gz
    install_size=$(wc -c < ${installDisk})
    printf '{"sha":"%s","size":%s}' "$install_sha" "$install_size" > $out/install-disk.json

    mkdir -p $out
    substituteInPlace index.html \
      --replace-fail __ASSETS__ v${ver} \
      --replace-fail __BOOT_MODE__ live
    cp index.html $out/index.html
    cp service-worker.js $out/service-worker.js
    cp _headers $out/_headers
    cp -r vendor $out/vendor
    cp -rL ${installerRepository} $out/install-repo

    # The hosting provider rejects individual assets larger than 25 MB.
    rootfs_bytes=$(wc -c < $out/rootfs-''${sha}.squashfs)
    if [ "$rootfs_bytes" -gt 25000000 ]; then
      echo "site rootfs is $rootfs_bytes bytes; hosting limit is 25000000" >&2
      exit 1
    fi

    runHook postInstall
  '';
  passthru = { inherit installDisk rootfs; };
}
