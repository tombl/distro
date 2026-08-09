{
  apk,
  apk-tools,
  bootFiles,
  busybox,
  guest-agent,
}:

apk.mkRepository {
  name = "site-installer";
  description = "tombl site installation repository";
  packages = {
    inherit
      apk-tools
      bootFiles
      busybox
      guest-agent
      ;
  };
}
