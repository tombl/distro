{
  apk,
  busybox,
  guest-agent,
  image,
  repository,
}:

image.mkFilesystem {
  name = "linux-guest-agent";
  label = "LOWLAND_AGENT";
  root = apk.mkSystem {
    name = "linux-guest-agent";
    repositories = [ repository ];
    packages = [
      busybox
      guest-agent
    ];
    files = {
      "/init" = {
        source = ./init.sh;
        mode = "0755";
      };
      "/bin/linux-guest-agent" = "${guest-agent}/bin/linux-guest-agent";
    };
  };
}
