{
  apk,
  busybox,
  guest-agent,
  image,
  pkgs,
  repository,
}:

let
  filesystem = image.mkFilesystem {
    name = "linux-guest-agent-filesystem";
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
  };
in
pkgs.runCommand "linux-guest-agent.img"
  {
    nativeBuildInputs = [ pkgs.gptfdisk ];
    passthru = filesystem.passthru // {
      partitionLabel = "LOWLAND_AGENT";
    };
  }
  ''
    sector_size=512
    # GPT occupies sectors 0-33 at the front and 33 sectors at the back.
    # This virtual, immutable disk needs no physical-device alignment gap.
    partition_start=34
    filesystem_bytes=$(stat -c %s ${filesystem})
    filesystem_sectors=$(((filesystem_bytes + sector_size - 1) / sector_size))
    partition_end=$((partition_start + filesystem_sectors - 1))
    disk_sectors=$((partition_start + filesystem_sectors + 33))

    truncate -s $((disk_sectors * sector_size)) "$out"
    sgdisk \
      --clear \
      --set-alignment=1 \
      --disk-guid=00000000-0000-0000-0000-000000000001 \
      --new=1:''${partition_start}:''${partition_end} \
      --typecode=1:0fc63daf-8483-4772-8e79-3d69d8477de4 \
      --partition-guid=1:00000000-0000-0000-0000-000000000002 \
      --change-name=1:LOWLAND_AGENT \
      "$out"
    dd if=${filesystem} of="$out" bs=$sector_size seek=$partition_start conv=notrunc status=none
    sgdisk --verify "$out"
  ''
