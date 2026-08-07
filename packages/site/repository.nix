# The site's little repository: busybox and apk-tools (the rootfs itself) plus
# a handful of installable packages for the browser guest. The index is built
# unsigned here; the publish script signs it with the CI-held key and uploads
# it to R2, so no private key ever enters the nix store.
{
  apk,
  apk-tools,
  busybox,
  ca-certificates,
  curl,
  file,
  git,
  jq,
  sqlite3,
}:

let
  repository = apk.mkRepository {
    name = "site";
    description = "tombl site demo repository";
    packages = {
      inherit
        apk-tools
        busybox
        ca-certificates
        curl
        file
        git
        jq
        sqlite3
        ;
    };
  };
in
repository
// {
  # The public half of the signing key, committed. The private half lives only
  # in the APK_SIGNING_KEY action secret.
  publicKey = ./keys/site.rsa.pub;
}
