{ pkgs }:

{
  name,
  version,
  hash,
}:

let
  archive = pkgs.fetchurl {
    url = "https://static.crates.io/crates/${name}/${name}-${version}.crate";
    inherit hash;
  };
in
pkgs.runCommand "${name}-${version}-source"
  {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
    ];
  }
  ''
    mkdir $out
    tar -xzf ${archive} --strip-components=1 -C $out
  ''
