{ pkgs }:

{
  name,
  init,
  contents ? [ ],
  size ? "64M",
}:

let
  initFile = pkgs.writeText "${name}-init" init;
in
pkgs.runCommand "${name}.rootfs.ext4"
  {
    nativeBuildInputs = [
      pkgs.e2fsprogs
      pkgs.gzip
    ];
  }
  ''
    mkdir -p root/bin root/dev root/proc root/sys root/tmp
    chmod 01777 root/tmp

    cp ${initFile} root/init
    chmod 0755 root/init

    for item in ${toString contents}; do
      cp -RP "$item"/. root/
    done

    mkdir -p $out
    truncate -s ${size} $out/rootfs.ext4
    mke2fs -q -t ext4 -d root -F -L rootfs -m 0 $out/rootfs.ext4
    gzip -c $out/rootfs.ext4 > $out/rootfs.ext4.gz
  ''
