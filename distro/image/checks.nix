# mkImage's own checks, run on the build host. Dependency resolution is
# checked at evaluation time; the resolver image is then built so host apk
# confirms it accepts the resolved closure. The modes check inspects encoded
# images.
{
  busybox,
  lib,
  mkImage,
  pkgs,
}:

let
  # Payload-only packages: APK conversion needs nothing but an FHS tree.
  toy =
    name: apk:
    pkgs.runCommand name { passthru.apk = apk; } ''
      mkdir -p $out/share/mkimage-check
      echo ${name} > $out/share/mkimage-check/${name}
    '';

  provider = toy "mkimage-check-provider" { provides = [ "mkimage-check-virtual=1.0" ]; };
  consumer = toy "mkimage-check-consumer" {
    depends = [
      "mkimage-check-virtual>=1.0"
      "!mkimage-check-absent"
      "busybox"
    ];
  };

  resolver = mkImage {
    name = "mkimage-check-resolver";
    packages = [
      consumer
      provider
      # Listing the same package twice is harmless.
      provider
    ];
  };

  # Same name and version, different payloads.
  duplicate = toy "mkimage-check-duplicate" { };
  impostor = pkgs.runCommand "mkimage-check-duplicate" { } ''
    mkdir -p $out/share/mkimage-check
    echo impostor > $out/share/mkimage-check/impostor
  '';
  fails =
    packages:
    !(builtins.tryEval
      (mkImage {
        name = "mkimage-check-failure";
        inherit packages;
      }).drvPath
    ).success;

  installed = map (package: package.name) resolver.packages;
  files = {
    "/etc/secret" = {
      source = pkgs.writeText "secret" "secret\n";
      mode = "0600";
    };
    "/bin/setuid" = {
      source = pkgs.writeScript "setuid" "#!/bin/sh\n";
      mode = "4755";
    };
    "/private" = {
      source = pkgs.runCommand "private" { } ''
        mkdir $out
        touch $out/file
      '';
      mode = "0700";
    };
    "/etc/plain" = pkgs.writeText "plain" "plain\n";
    # Directories onto ones apk created merge into them.
    "/etc" = pkgs.runCommand "merged-etc" { } ''
      mkdir $out
      echo merged > $out/merged
    '';
    "/usr" = {
      source = pkgs.runCommand "merged-usr" { } ''
        mkdir -p $out/bin
        printf '#!/bin/sh\n' > $out/bin/tool
        chmod +x $out/bin/tool
      '';
      mode = "0750";
    };
  };
  # Modes `stat -c %a` reports for each path, /tmp from the FHS layer.
  expected = {
    "/etc/secret" = "600";
    "/bin/setuid" = "4755";
    "/private" = "700";
    "/private/file" = "644";
    "/etc/plain" = "644";
    "/tmp" = "1777";
    # A merge lands beside the existing contents rather than nested under the
    # store name, and only a requested mode changes the directory.
    "/etc" = "755";
    "/etc/merged" = "644";
    "/etc/apk/world" = "644";
    "/usr" = "750";
    "/usr/bin" = "755";
    "/usr/bin/tool" = "755";
  };
  paths = builtins.attrNames expected;
  image =
    format:
    mkImage {
      name = "image-modes";
      packages = [ busybox ];
      inherit files format;
      size = "16M";
    };
  erofs = image "erofs";
  ext4 = image "ext4";
in
# A virtual dependency is satisfied by its requested provider, a `!` conflict
# installs nothing, and busybox still comes from the scope.
assert lib.assertMsg (
  installed == [
    "busybox"
    "mkimage-check-consumer"
    "mkimage-check-provider"
  ]
) "mkImage resolved ${builtins.toJSON installed}";
assert lib.assertMsg (
  fails [
    duplicate
    impostor
  ]
  && fails [
    impostor
    duplicate
  ]
) "mkImage accepted two different packages named mkimage-check-duplicate";
assert lib.assertMsg (fails [
  consumer
]) "mkImage resolved a virtual dependency without its provider";
{
  inherit resolver;
  modes =
    pkgs.runCommand "image-modes-check"
      {
        nativeBuildInputs = [
          pkgs.e2fsprogs
          pkgs.erofs-utils
          pkgs.fakeroot
        ];
      }
      ''
        check() {
          if [ "$3" != "$2" ]; then
            echo "$1: mode $3, expected $2" >&2
            exit 1
          fi
        }
        # The sandbox refuses real setuid bits, so the EROFS image is extracted
        # under fakeroot, which keeps the image's modes in its own records.
        # debugfs's rdump drops setuid bits, so ext4 modes are read in place.
        erofs=$(fakeroot sh -c '
          umask 0
          fsck.erofs --extract=erofs ${erofs} >&2
          ${lib.concatMapStrings (path: ''
            stat -c %a erofs${path}
          '') paths}
        ')
        ${lib.concatImapStrings (index: path: ''
          check "erofs ${path}" ${expected.${path}} "$(echo "$erofs" | sed -n ${toString index}p)"
          check "ext4 ${path}" ${expected.${path}} \
            "$(debugfs -R "stat ${path}" ${ext4} 2>/dev/null | sed -n 's/.*Mode: *0*\([0-7]*\).*/\1/p')"
        '') paths}
        touch $out
      '';
}
