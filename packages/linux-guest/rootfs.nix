{
  apk,
  busybox,
  guest-agent,
  image,
  pkgs,
}:

let
  profile = apk.mkProfile {
    name = "distro-guest";
    depends = [
      (apk.dep busybox.apk)
      (apk.dep guest-agent.apk)
    ];
    files."/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
    links."/init" = "/bin/linux-guest-agent";
  };
  systemRepository = apk.mkRepository {
    name = "guest-system";
    packages = { inherit profile; };
    includeDependencies = true;
  };
  system = apk.mkSystem {
    name = "guest";
    repositories = [ systemRepository ];
    packages = [ profile ];
  };
in
image.mkFilesystem {
  name = "guest-rootfs";
  root = system;
}
