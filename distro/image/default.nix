# mkImage: the one image constructor. Every root filesystem in this repository,
# from the site's live image to a single package's VM test, is an mkImage
# result. The APK machinery behind it is private: images name derivations, not
# repositories or package files.
#
#   mkImage {
#     name;              # store name; the output is "${name}.${format}"
#     packages;          # guest derivations to install, e.g. [ busybox jq ]
#     files ? { };       # "/abs/path" = path | store path string
#                        #             | { source; mode ? null; }
#     links ? { };       # "/abs/path" = "symlink target"
#     format ? "erofs";  # "erofs" (immutable) or "ext4" (writable)
#     label ? "LOWLAND_ROOT";  # filesystem label, at most 15 characters
#     size ? "256M";     # ext4 capacity; EROFS is always exactly its contents
#   }
#
# Each package is converted to an APK from its passthru.apk metadata and
# installed by apk, so the image carries a real package database and a booted
# guest can upgrade or remove what the build installed. A package's
# passthru.apk.depends names other packages; mkImage resolves them
# transitively, first against `packages` and then against the package scope by
# attribute name, so an image lists only what it wants and builds only that
# closure. Only `packages` are recorded in /etc/apk/world: dependencies stay
# removable once nothing needs them. A downstream package can depend on
# another downstream package either by listing both in `packages` or by adding
# it to the scope with overrideScope.
#
# `files` and `links` are layered over the installed packages; their paths
# must be absolute and normalized, and a file mode is an octal string. The
# image then gains the standard FHS mount points (with a sticky,
# world-writable /tmp) and is encoded with every file owned by root. EROFS
# images are bit-for-bit reproducible.
#
# The result is the image file itself. passthru carries `format`, `label`,
# and `packages`, the APKs of the installed closure.
{
  apk,
  lib,
  pkgs,
  scope,
}:

let
  mkFilesystem = import ./filesystem.nix { inherit lib pkgs; };

  # A dependency atom may carry a version constraint (`name>=1.0`); the name
  # alone selects the package that satisfies it.
  dependencyName = atom: builtins.head (builtins.match "([^<>=~]+).*" atom);
in

{
  name,
  packages,
  files ? { },
  links ? { },
  format ? "erofs",
  label ? "LOWLAND_ROOT",
  size ? "256M",
}:

let
  requested = map apk.packageFrom packages;
  requestedByName = lib.listToAttrs (map (package: lib.nameValuePair package.name package) requested);

  fromScope =
    dependent: dependency:
    let
      package = apk.packageFrom scope.${dependency};
    in
    if !lib.isDerivation (scope.${dependency} or null) then
      throw "mkImage ${name}: ${dependent} depends on unknown package ${dependency}; add it to packages or to the scope"
    else if package.name != dependency then
      throw "mkImage ${name}: ${dependent} depends on ${dependency}, but the scope's ${dependency} is packaged as ${package.name}"
    else
      package;

  lookup = dependent: dependency: requestedByName.${dependency} or (fromScope dependent dependency);

  closure = map (item: item.package) (
    builtins.genericClosure {
      startSet = map (package: {
        key = package.name;
        inherit package;
      }) requested;
      operator =
        item:
        map (
          dependency:
          let
            dependencyKey = dependencyName dependency;
          in
          {
            key = dependencyKey;
            package = lookup item.package.name dependencyKey;
          }
        ) item.package.depends;
    }
  );

  # A throwaway index holding exactly the closure: apk then solves and installs
  # the image the same way a booted guest installs from the published one.
  repository = apk.mkRepository {
    inherit name;
    packages = lib.listToAttrs (map (package: lib.nameValuePair package.name package) closure);
  };

  root = apk.mkSystem {
    inherit name files links;
    repositories = [ repository ];
    packages = requested;
  };
in
assert lib.assertMsg (packages != [ ]) "mkImage ${name} requires at least one package";
mkFilesystem {
  inherit
    name
    root
    format
    label
    size
    ;
  passthru.packages = repository.packages;
}
