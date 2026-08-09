# A deliberately small build-time repository for constructing the live image.
# The guest's /etc/apk/repositories points at the full published repository, so
# optional demo packages do not need to be built merely to assemble the rootfs.
{
  apk,
  apk-tools,
  busybox,
  guest-agent,
}:

let
  repository = apk.mkRepository {
    name = "site-bootstrap";
    description = "tombl site bootstrap repository";
    packages = {
      inherit apk-tools busybox guest-agent;
    };
  };
in
repository
// {
  publicKey = ./keys/site.rsa.pub;
}
