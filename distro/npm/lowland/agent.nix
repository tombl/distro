{
  guest-agent,
  pkgs,
}:

# The agent as an initramfs: an uncompressed newc archive holding only /init.
# The kernel unpacks it over its built-in archive and runs it as PID 1, so the
# agent needs no disk of its own. Everything else comes from the host's mounts.
pkgs.runCommand "linux-guest-agent.cpio"
  {
    nativeBuildInputs = [ pkgs.cpio ];
  }
  ''
    mkdir root
    install -m 0755 ${guest-agent}/bin/linux-guest-agent root/init
    touch -d @1 root/init
    (cd root && printf 'init\0' | cpio --null --reproducible --owner=0:0 -H newc -o --quiet) > $out
    # The archive holds exactly /init, which is what the kernel runs.
    [ "$(cpio -it --quiet < $out)" = init ]
  ''
