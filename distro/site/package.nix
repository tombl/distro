{
  bytes,
  pkgs,
  kernel,
  linux-guest,
  rootfs,
}:

let
  # The kernel assets are content-stable per build but served under fixed
  # names, so they are cached immutable under a build-versioned directory:
  # a new build changes the version and every URL, so browsers never revalidate
  # the heavy kernel libraries across the guest's many workers. The version
  # tracks the kernel, the guest SDK, and the rootfs.
  ver = builtins.substring 0 16 (
    builtins.hashString "sha256" "${bytes}${kernel}${linux-guest.package}${rootfs}"
  );
in

pkgs.stdenvNoCC.mkDerivation {
  pname = "site";
  version = "0.0.0";
  src = ../../apps/site;

  installPhase = ''
    runHook preInstall

    # The kernel assets sit under a fixed /static/ prefix with a per-build
    # version directory, so a single _headers splat (/* is greedy across
    # slashes, and only one splat is allowed per rule) can mark them immutable.
    mkdir -p $out/static/v${ver}
    # dist/index.js loads vmlinux.wasm relative to itself (../vmlinux.wasm),
    # so the kernel library and kernel sit as siblings inside the versioned
    # directory, exactly as the kernel package lays them out.
    cp -rL ${kernel}/dist $out/static/v${ver}/dist
    cp -L ${kernel}/vmlinux.wasm $out/static/v${ver}/vmlinux.wasm
    cp -rL ${bytes}/dist $out/static/v${ver}/bytes
    cp -rL ${linux-guest.package}/dist $out/static/v${ver}/guest
    cp -L ${linux-guest.package}/agent.erofs $out/static/v${ver}/agent.erofs

    # The EROFS image is immutable and is served under its content hash, so the
    # page can read it directly into the block device.
    sha=$(${pkgs.openssl}/bin/openssl dgst -sha256 -r ${rootfs} | awk '{ print $1 }')
    cp ${rootfs} $out/rootfs-''${sha}.erofs

    mkdir -p $out
    substituteInPlace index.html --replace-fail __ASSETS__ v${ver}
    substituteInPlace index.html --replace-fail __ROOTFS__ rootfs-''${sha}.erofs
    cp index.html $out/index.html
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
