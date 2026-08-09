{
  apk,
  apk-tools,
  bootFiles,
  busybox,
  guest-agent,
}:

let
  repository = apk.mkRepository {
    name = "site-system";
    description = "tombl site system repository";
    packages = {
      inherit
        apk-tools
        bootFiles
        busybox
        guest-agent
        ;
    };
  };
in
repository
// {
  publicKey = ./keys/site.rsa.pub;
}
