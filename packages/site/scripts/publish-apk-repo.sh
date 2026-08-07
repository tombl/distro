#!/usr/bin/env -S nix develop .#ci --command bash
# shellcheck shell=bash
# Signs the site's apk repository with the CI-held key and uploads it to R2.
# The signing key is a base64 PEM in $APK_SIGNING_KEY (an action secret); it
# only ever touches a temporary file in the runner, never the nix store.
set -euo pipefail

repo=$(nix build --no-link --print-out-paths .#site-repository)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/wasm32"
cp "$repo"/wasm32/*.apk "$work/wasm32/"

if [ -z "${APK_SIGNING_KEY:-}" ]; then
  echo "APK_SIGNING_KEY is not set" >&2
  exit 1
fi
printf '%s' "$APK_SIGNING_KEY" | base64 -d >"$work/site.key"

# mkndx needs --allow-untrusted to read the (unsigned) package files; the
# --sign-key below is what makes the index itself trusted.
apk --allow-untrusted mkndx \
  --sign-key "$work/site.key" \
  --compression deflate:9 \
  --description "tombl site demo repository" \
  --output "$work/wasm32/Packages.adb" \
  "$work/wasm32/"*.apk

# rclone reads the R2 remote from RCLONE_CONFIG_R2_* env vars.
rclone copyto "$work/wasm32" r2:tombl-apk/wasm32 --create-empty-src-dirs
