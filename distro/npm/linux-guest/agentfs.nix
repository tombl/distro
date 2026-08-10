{
  apk,
  busybox,
  guest-agent,
  image,
  pkgs,
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
      # The agent image is EROFS, so mount points needed before pivot_root
      # must exist in the built image rather than being created during boot.
      "/lower/.mountpoint" = pkgs.emptyFile;
      "/overlay/.mountpoint" = pkgs.emptyFile;
    };
  };
}
