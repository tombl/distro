#!/bin/busybox sh
set -e

# Versioned assets are installed before this script runs. Replace the one
# unversioned entry point last so a reload sees a complete boot tree.
cp /usr/share/lowland-boot/index.html /boot/.index.html.new
mv -f /boot/.index.html.new /boot/index.html
