#!/usr/bin/env bash
set -euo pipefail

site_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd -- "$site_dir/../.." && pwd)

image=$(nix build "$repo_dir#site.image" --no-link --print-out-paths)

mkdir -p "$site_dir/public"
gzip --best --no-name --stdout "$image/initramfs.cpio" >"$site_dir/public/initramfs.cpio.gz.tmp"
gzip --best --no-name --stdout "$image/rootfs.squashfs" >"$site_dir/public/rootfs.squashfs.gz.tmp"
mv -f "$site_dir/public/initramfs.cpio.gz.tmp" "$site_dir/public/initramfs.cpio.gz"
mv -f "$site_dir/public/rootfs.squashfs.gz.tmp" "$site_dir/public/rootfs.squashfs.gz"
