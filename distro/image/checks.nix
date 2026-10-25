# mkImage's own checks. Dependency resolution is checked at evaluation time;
# the resolver image is then built so host apk confirms it accepts the
# resolved closure.
{
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
}
