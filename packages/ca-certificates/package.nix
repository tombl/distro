{
  pkgs,
  stdenv,
}:

# The CA bundle used by HTTPS tools at runtime. One package owns the file so
# curl, git, and friends can depend on it instead of each shipping a copy that
# conflicts at install time.
stdenv.mkDerivation {
  pname = "ca-certificates";
  version = "0.0.0";
  dontUnpack = true;
  dontBuild = true;
  installPhase = ''
    mkdir -p $out/etc/ssl/certs
    cp ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/certs/ca-certificates.crt
  '';
}
