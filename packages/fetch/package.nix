{
  run,
  lib,
  curl,
}:

let
  mkFetcher =
    command:
    {
      url,
      name ? builtins.baseNameOf url,
      hash ? lib.fakeHash,
    }:
    run {
      inherit name url;
      outputHashMode = "nar";
      outputHashAlgo = "sha256";
      outputHash = hash;
      path = [ curl ];
    } command;
in

rec {
  file = mkFetcher ''
    curl -L "$url" -o $out
  '';
  tar = mkFetcher ''
    mkdir $out
    case "$url" in
      *gz)  decompress=-z ;;
      *bz2) decompress=-j ;;
      *xz)  decompress=-J ;;
      *lz)  decompress=--lzma ;;
      *)    decompress= ;;
    esac
    curl -L "$url" | tar -x $decompress -C $out --strip-components=1
  '';
  zip = mkFetcher ''
    mkdir $out
    curl -L "$url" | unzip - -d $out
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
