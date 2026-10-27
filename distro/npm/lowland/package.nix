{
  apk-tools-host,
  assets,
  busybox,
  canonicalExt4,
  jq,
  lib,
  mkImage,
  node-workspace,
  pkgs,
  test-assets,
}:

let
  inherit ((builtins.fromJSON (builtins.readFile ../../../packages/lowland/package.json))) version;

  # Every step runs pnpm in the workspace the source paths give.
  workspaceBuild =
    {
      pname,
      paths,
      buildPhase,
      installPhase,
      nativeBuildInputs ? [ ],
      passthru ? { },
    }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit
        pname
        version
        buildPhase
        installPhase
        passthru
        ;
      src = node-workspace.source ([ "tsconfig.base.json" ] ++ paths);
      env.CI = "true";
      pnpmDeps = node-workspace.deps;
      nativeBuildInputs = [
        pkgs.nodejs_26
        pkgs.pnpmConfigHook
        node-workspace.pnpm
      ]
      ++ nativeBuildInputs;
    };

  # The machine layer alone, compiled without Node's types and unit-tested.
  # vm-test boots kernels through it, so those checks rerun only when the
  # machine or the kernel changes, not the rest of the package.
  machine = workspaceBuild {
    pname = "lowland-machine";
    nativeBuildInputs = [ pkgs.wasm-tools ];
    paths = [
      "packages/lowland/tsconfig.json"
      "packages/lowland/src/bytes"
      "packages/lowland/src/machine"
      "packages/lowland/test/machine"
    ];
    buildPhase = ''
      runHook preBuild

      cd packages/lowland
      echo '{ "extends": "./tsconfig.json", "compilerOptions": { "types": [] }, "include": ["src/machine/**/*.ts"] }' \
        >tsconfig.machine.json
      pnpm exec tsc -p tsconfig.machine.json
      pnpm run test:machine

      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall

      mkdir -p $out/assets
      cp -r dist $out/dist
      echo '{ "type": "module" }' >$out/package.json
      cp ${assets.kernel.path} $out/assets/${assets.kernel.name}

      runHook postInstall
    '';
  };

  # The compiled package without its assets. Tests are left to the checks, so
  # a change to them rebuilds nothing that depends on the JavaScript.
  dist = workspaceBuild {
    pname = "lowland-dist";
    paths = [
      "packages/lowland/src"
      "packages/lowland/tsconfig.json"
      "packages/lowland/tsconfig.web.json"
    ];
    buildPhase = ''
      runHook preBuild

      cd packages/lowland
      pnpm exec tsc --noEmit
      pnpm exec tsc -p tsconfig.web.json
      pnpm run build

      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp -r dist $out/dist

      runHook postInstall
    '';
  };

  # The workspace with the compiled package and every asset in place.
  materialize = node-workspace.installBuilt {
    lowland = dist;
    assets = lib.attrValues assets;
  };

  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "lowland";
    inherit version;
    src = node-workspace.source [
      "packages/lowland/LICENSE"
      "packages/lowland/README.md"
      "scripts/pack-package.mjs"
      "scripts/packages.mjs"
    ];
    nativeBuildInputs = [ pkgs.nodejs_26 ];

    buildPhase = ''
      runHook preBuild

      export HOME=$TMPDIR
      ${materialize}

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      node scripts/pack-package.mjs packages/lowland --out $out/package.tgz
      tar -xzf $out/package.tgz --strip-components=1 -C $out

      runHook postInstall
    '';

    passthru.checks = checks;
  };

  # The tests' type check and the unit tests that boot nothing.
  unit = workspaceBuild {
    pname = "lowland-unit-test";
    paths = [
      "packages/lowland/src"
      "packages/lowland/test"
      "packages/lowland/tsconfig.json"
      "scripts/test-assets.ts"
    ];
    buildPhase = ''
      runHook preBuild

      cd packages/lowland
      pnpm exec tsc -p test
      node --test test/cli.test.ts test/node/*.test.ts

      runHook postBuild
    '';
    installPhase = "touch $out";
  };

  # mkImage's passthru carries the APKs it would install; reading them does
  # not build the image itself.
  testPackages = lib.listToAttrs (
    map (package: lib.nameValuePair package.name package)
      (mkImage {
        name = "lowland-image-test-packages";
        packages = [
          busybox
          jq
        ];
      }).packages
  );
  busyboxPackage = testPackages.busybox;
  jqPackage = testPackages.jq;

  # A repository index that nothing signs, which the build helper must refuse
  # even when local packages are installed without signature checks.
  unsignedRepository =
    pkgs.runCommand "lowland-image-unsigned-repository"
      {
        nativeBuildInputs = [ apk-tools-host ];
      }
      ''
        mkdir -p $out/wasm32
        cp ${jqPackage}/${jqPackage.filename} $out/wasm32/${jqPackage.filename}
        apk --allow-untrusted mkndx --output $out/wasm32/Packages.adb $out/wasm32/*.apk
      '';

  # The directory layout test/image/assets.ts and test/assets.ts consume, via
  # LOWLAND_IMAGE_TEST_ASSETS and LOWLAND_TEST_ASSETS or by building this
  # attribute themselves. A local package keeps the build helper tests
  # hermetic in the network-less Nix sandbox.
  imageAssets = pkgs.linkFarm "lowland-image-test-assets" {
    "busybox.apk" = "${busyboxPackage}/${busyboxPackage.filename}";
    "jq.apk" = "${jqPackage}/${jqPackage.filename}";
    "rootfs.ext4" = canonicalExt4;
    "unsigned-repository" = unsignedRepository;
  };

  checks = {
    inherit unit;

    # Bundles small applications against the packed package with Vite and
    # esbuild, and checks that each output contains the assets of what it
    # imports and no others (packages/bundle-check/check.ts). The table of
    # results and sizes is the output.
    bundle-assets = workspaceBuild {
      pname = "lowland-bundle-check";
      paths = [ "packages/bundle-check" ];
      buildPhase = ''
        runHook preBuild

        rm packages/bundle-check/node_modules/lowland
        ln -s ${package} packages/bundle-check/node_modules/lowland
        pnpm --filter=@lowland/bundle-check check
        if ! pnpm --silent --filter=@lowland/bundle-check test >bundles.md; then
          cat bundles.md
          exit 1
        fi
        cat bundles.md

        runHook postBuild
      '';
      installPhase = ''
        mkdir $out
        cp bundles.md $out/
      '';
    };

    guest.integration = node-workspace.mkTest {
      name = "lowland-guest-integration-test";
      paths = [
        "packages/lowland/src/browser"
        "packages/lowland/src/bytes"
        "packages/lowland/src/guest"
        "packages/lowland/src/machine"
        "packages/lowland/src/node"
        "packages/lowland/test/guest"
      ];
      built.assets = [
        assets.kernel
        assets.agent
      ];
      assets = test-assets.select [
        "boot.cpio"
        "getdents-inode"
        "lifecycle.erofs"
        "network-test"
        "rootfs.erofs"
        "rootfs.ext4"
        "user-trap"
      ];
      command = ''
        timeout --kill-after=5 300 pnpm --filter=lowland test:guest
      '';
    };

    image = {
      assets = imageAssets;
      integration = node-workspace.mkTest {
        name = "lowland-image-integration-test";
        paths = [
          "packages/lowland/src/bytes"
          "packages/lowland/src/guest"
          "packages/lowland/src/image"
          "packages/lowland/src/machine"
          "packages/lowland/src/node"
          "packages/lowland/test/image"
        ];
        built.assets = lib.attrValues assets;
        assets = imageAssets;
        env.LOWLAND_IMAGE_TEST_ASSETS = imageAssets;
        command = ''
          timeout --kill-after=5 600 pnpm --filter=lowland test:image
        '';
      };
    };

    cli = {
      # Builds an image with the published command line from a local
      # package, so it needs no network, and checks that the result is an
      # EROFS image.
      smoke =
        pkgs.runCommand "lowland-smoke-test"
          {
            nativeBuildInputs = [ pkgs.nodejs_26 ];
            passthru.ci.heavy = true;
          }
          ''
            echo hello >motd
            timeout --kill-after=5 600 node ${package}/dist/cli/cli.js build \
              -p ${imageAssets}/busybox.apk \
              -f motd:/etc/motd:0644 \
              -l /usr/bin/hi=/bin/busybox \
              -o image.erofs
            magic=$(od -An -tx4 -j1024 -N4 image.erofs | tr -d ' ')
            if [[ $magic != e0f5e1e2 ]]; then
              echo "lowland build wrote no EROFS image (magic $magic)" >&2
              exit 1
            fi
            mkdir $out
          '';

      # Boots machines through lowland run and the Linux API: commands, exit
      # statuses, standard I/O, terminals, host directories, disks, and the
      # ephemeral root. Python drives lowland run on a host pseudoterminal.
      integration = node-workspace.mkTest {
        name = "lowland-integration-test";
        paths = [
          "packages/lowland/src"
          "packages/lowland/test"
        ];
        built.assets = lib.attrValues assets;
        assets = imageAssets;
        nativeBuildInputs = [ pkgs.python3 ];
        command = ''
          timeout --kill-after=5 900 pnpm --filter=lowland test:cli
        '';
      };
    };
  };
in
{
  inherit dist machine package;
}
