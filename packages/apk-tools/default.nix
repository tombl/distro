{
  callPackage,
  pkgs,
  src ? pkgs.fetchzip {
    url = "https://gitlab.alpinelinux.org/alpine/apk-tools/-/archive/b5a31c0d865342ad80be10d68f1bb3d3ad9b0866/apk-tools-b5a31c0d865342ad80be10d68f1bb3d3ad9b0866.tar.gz";
    hash = "sha256-iuJFgsn4yfQYqichMVhnOHFYj+5xPZYnXaCW0ZkKbRU=";
  },
  basic-init,
  busybox,
  bzip2,
  curl,
  dropbear,
  file,
  git,
  guest-agent,
  jq,
  kselftests,
  ltp,
  lua,
  make,
  ncurses,
  openssl,
  python,
  quickjs,
  readline,
  sqlite3,
  xz,
  zlib,
  zstd,
  image,
  vm-test,
}:

let
  rawPackage = callPackage ./package.nix { inherit src; };
  adapter = callPackage ./repository.nix { };
  packageSpecs = [
    {
      package = busybox;
      name = "busybox";
      version = "0-r0";
    }
    {
      package = rawPackage;
      name = "apk-tools";
    }
    {
      package = basic-init;
      name = "basic-init";
      version = "0-r0";
    }
    {
      package = make;
      replaces = [ "busybox" ];
    }
    {
      package = file;
      replaces = [ "busybox" ];
    }
    { package = jq; }
    { package = lua; }
    { package = quickjs; }
    { package = python; }
    { package = readline; }
    { package = ncurses; }
    {
      package = sqlite3;
      replaces = [ "busybox" ];
    }
    {
      package = xz;
      replaces = [ "busybox" ];
    }
    { package = zstd; }
    {
      package = bzip2;
      replaces = [ "busybox" ];
    }
    { package = openssl; }
    { package = zlib; }
    { package = curl; }
    { package = git; }
    { package = dropbear; }
    { package = guest-agent; }
    { package = kselftests; }
    { package = ltp; }
  ];
  packages = map adapter.mkPackage packageSpecs;
  demoPackages = builtins.filter (
    p:
    builtins.elem p.name [
      "jq"
      "lua"
    ]
  ) packages;
  scriptPayload = pkgs.runCommand "apk-script-test-payload" { } ''
    mkdir -p $out/share/apk-script-test
    touch $out/share/apk-script-test/payload
  '';
  scriptedPackage = adapter.mkPackage {
    package = scriptPayload;
    name = "apk-script-test";
    version = "1-r0";
    scripts.post-install = ./post-install.sh;
  };
  demoRepository = adapter.mkRepository {
    name = "apk-install-demo";
    packages = demoPackages ++ [ scriptedPackage ];
  };
  repositorySlice = pkgs.runCommand "apk-install-demo-rootfs-slice" { } ''
    mkdir -p $out/repo
    cp -R ${demoRepository}/. $out/repo/
  '';
  demoRootfs = image.mkRootfs {
    name = "apk-install-demo";
    format = "ext4";
    size = "128M";
    init = ./install-test.sh;
    contents = [
      busybox
      rawPackage
      repositorySlice
    ];
  };
  installCheck = vm-test.vmTest {
    name = "apk-tools-install";
    initramfs = image.bootInitramfs;
    disk = demoRootfs;
  };
  package = rawPackage // {
    checks.install = installCheck;
  };
in
{
  inherit package packages;
  inherit (adapter) mkPackage mkRepository;

  repository = adapter.mkRepository {
    name = "distro";
    inherit packages;
  };

  demo = {
    inherit demoRepository demoRootfs;
    recurseForDerivations = true;
  };

  recurseForDerivations = true;
}
