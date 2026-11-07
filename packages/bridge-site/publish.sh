#!/usr/bin/env -S nix develop .#ci --command bash
# shellcheck shell=bash
# Uploads the bridge site to the Garage bucket that serves *.localhost.low.land.
# rclone reads the garage remote from RCLONE_CONFIG_GARAGE_* env vars. The host
# adds the bridge's security headers; each object carries its own Content-Type,
# from its extension, and Cache-Control.
set -euo pipefail

site=$(nix build --no-link --print-out-paths .#bridge-site)
bucket="garage:localhost.low.land"

# Every file revalidates, so a rollout reaches each page on its next load.
# Store paths share one mtime, so compare by checksum.
rclone sync "$site" "$bucket" --checksum --header-upload "Cache-Control: no-cache"
