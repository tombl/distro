{
  busybox,
  guest-agent,
  mkRootfs,
  pkgs,
}:

{
  name,
  contents ? [ ],
  files ? { },
}:

mkRootfs {
  inherit name;
  init = "${guest-agent}/bin/linux-guest-agent";
  contents = [ busybox ] ++ contents;
  files = {
    "/etc/resolv.conf" = pkgs.writeText "resolv.conf" ''
      nameserver 192.0.2.1
    '';
  }
  // files;
}
