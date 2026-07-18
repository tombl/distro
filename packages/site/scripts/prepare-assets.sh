#!/usr/bin/env bash
set -euo pipefail

site_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd -- "$site_dir/../.." && pwd)

initramfs=$(nix build "$repo_dir#guest-initramfs" --no-link --print-out-paths)
rootfs=$(nix build "$repo_dir#site-rootfs" --no-link --print-out-paths)

mkdir -p "$site_dir/public"
gzip --best --no-name --stdout "$initramfs" >"$site_dir/public/initramfs.cpio.gz.tmp"
gzip --best --no-name --stdout "$rootfs" >"$site_dir/public/rootfs.squashfs.gz.tmp"
mv -f "$site_dir/public/initramfs.cpio.gz.tmp" "$site_dir/public/initramfs.cpio.gz"
mv -f "$site_dir/public/rootfs.squashfs.gz.tmp" "$site_dir/public/rootfs.squashfs.gz"
rm -f "$site_dir/public/rootfs.ext4.gz"
