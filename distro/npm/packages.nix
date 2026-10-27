{
  kernel,
  lib,
  linux-guest,
  lowland,
  lowland-image,
  node-workspace,
  pkgs,
}:

let
  # Every published npm package, by name. A workspace package is published iff
  # its package.json is not private (scripts/packages.mjs), and the
  # published-set check keeps this map equal to that set.
  published = {
    "@lowland/kernel" = kernel;
    "@lowland/guest" = linux-guest.package;
    "@lowland/image" = lowland-image.package;
    inherit lowland;
  };

  # @scope/name → scope-name.tgz, as in scripts/packages.mjs.
  tarball = name: "${lib.replaceStrings [ "@" "/" ] [ "" "-" ] name}.tgz";
  entries = lib.mapAttrsToList (name: package: {
    inherit name;
    tarball = tarball name;
    path = "${package}/package.tgz";
  }) published;

  expected = builtins.toJSON (map (entry: { inherit (entry) name tarball; }) entries);

  publishedSet =
    pkgs.runCommand "npm-packages-published-set"
      {
        src = node-workspace.source [ "scripts/packages.mjs" ];
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nodejs_26
        ];
        inherit expected;
        passAsFile = [ "expected" ];
      }
      ''
        cd $src
        node scripts/packages.mjs >$TMPDIR/published.json
        node scripts/packages.mjs --versioned >/dev/null
        if ! diff -u \
          <(jq --sort-keys 'map({name, tarball}) | sort_by(.name)' $TMPDIR/published.json) \
          <(jq --sort-keys 'sort_by(.name)' $expectedPath); then
          echo "distro/npm/packages.nix publishes a different set than the non-private package.json files" >&2
          exit 1
        fi
        touch $out
      '';
in
pkgs.linkFarm "npm-packages" (
  map (entry: {
    name = entry.tarball;
    inherit (entry) path;
  }) entries
)
// {
  checks.published-set = publishedSet;
}
