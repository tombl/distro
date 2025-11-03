{
  run,
  lib,
}:

rec {
  file =
    {
      url,
      name ? builtins.baseNameOf url,
      hash ? lib.fakeHash,
    }:
    import <nix/fetchurl.nix> {
      inherit url name hash;
    };
  tar =
    args:
    let
      result = file args;
    in
    run { inherit (result) name; } ''
      mkdir $out
      case "${result.url}" in
        *gz)  decompress=-z ;;
        *bz2) decompress=-j ;;
        *xz)  decompress=-J ;;
        *lz)  decompress=--lzma ;;
        *)    decompress= ;;
      esac
      tar -x $decompress -f ${result} -C $out --strip-components=1
    '';
  zip =
    args:
    let
      result = file args;
    in
    run { inherit (result) name; } ''
      mkdir $out
      unzip -f ${result} -d $out
    '';
  github =
    {
      owner,
      repo,
      rev,
      ...
    }@args:
    tar (
      {
        url = "https://github.com/${owner}/${repo}/archive/${rev}.tar.gz";
        name = "${owner}-${repo}-${builtins.baseNameOf rev}";
      }
      // removeAttrs args [
        "url"
        "owner"
        "repo"
        "rev"
      ]
    );
}
