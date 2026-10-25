#!/usr/bin/env -S nix develop .#ci --command bash
# shellcheck shell=bash
# Signs the site's apk repository with the CI-held key and uploads it to R2.
# The signing key is a base64 PEM in $APK_SIGNING_KEY (an action secret); it
# only ever touches a temporary file in the runner, never the nix store.
#
# Package files are content-addressed (see distro/apk/repository.nix): a file
# name changes whenever its bytes do, so APKs are uploaded once, never
# overwritten, and served as immutable. Packages.adb is the only mutable object
# and is served with no-cache. Each replaced index is kept under retired/ for
# a grace period, and APKs stay published while any retained index names them,
# so clients holding a recently fetched index can still download from it.
set -euo pipefail

grace_days=7
repo=$(nix build --no-link --print-out-paths .#repository)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/wasm32"
cp "$repo"/wasm32/* "$work/wasm32/"
chmod u+w "$work/wasm32/Packages.adb"

if [ -z "${APK_SIGNING_KEY:-}" ]; then
  echo "APK_SIGNING_KEY is not set" >&2
  exit 1
fi
printf '%s' "$APK_SIGNING_KEY" | base64 -d >"$work/site.key"

# Sign the Nix-built index in place, so the published index is exactly the one
# the site checks tested, plus a signature.
apk --allow-untrusted adbsign --sign-key "$work/site.key" "$work/wasm32/Packages.adb"

# Prints the package file names an index refers to. Indexes published before
# content addressing carry no pkgname-spec and use apk's default.
index_files() {
  apk --allow-untrusted adbdump "$1" | awk '
    BEGIN { spec = "${name}-${version}.apk" }
    /^pkgname-spec: / { spec = $2 }
    /^  - name: / { field[++n, "name"] = $3 }
    /^    (version|hashes|arch): / { field[n, substr($1, 1, length($1) - 1)] = $2 }
    # adbdump prints pkgname-spec after the packages.
    END {
      for (i = 1; i <= n; i++) {
        out = ""
        rest = spec
        while (match(rest, /\$\{[a-z]+(:[0-9]+)?\}/)) {
          key = substr(rest, RSTART + 2, RLENGTH - 3)
          len = 0
          if (index(key, ":")) {
            len = substr(key, index(key, ":") + 1) + 0
            key = substr(key, 1, index(key, ":") - 1)
          }
          value = field[i, key == "hash" ? "hashes" : key]
          if (len) value = substr(value, 1, len)
          out = out substr(rest, 1, RSTART - 1) value
          rest = substr(rest, RSTART + RLENGTH)
        }
        print out rest
      }
    }
  '
}

# The prune below deletes whatever the indexes do not name, so first check that
# the new index names exactly the files being published.
if ! diff <(index_files "$work/wasm32/Packages.adb" | sort) \
  <(cd "$work/wasm32" && printf '%s\n' *.apk | sort); then
  echo "Packages.adb does not name exactly the published APK files" >&2
  exit 1
fi

# rclone reads the R2 remote from RCLONE_CONFIG_R2_* env vars. The bucket is
# bound to the assets.low.land custom domain, so /apk/wasm32/... serves as
# https://assets.low.land/apk/wasm32/...
bucket="${R2_BUCKET:?set R2_BUCKET to the R2 bucket name}"
remote="r2:${bucket}/apk/wasm32"

# 1. Packages first, so the new index never names a missing file. --immutable
# fails the publish rather than replace an existing name with different bytes.
rclone copy "$work/wasm32" "$remote" \
  --include '*.apk' --max-depth 1 \
  --checksum --immutable \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable'

# 2. Retire the live index, then replace it. Listings go through files so a
# failed listing stops the publish instead of reading as empty.
now=$(date -u +%Y%m%dT%H%M%SZ)
rclone lsf "$remote" --files-only --max-depth 1 >"$work/published"
if grep -qx Packages.adb "$work/published"; then
  rclone copyto "$remote/Packages.adb" "$remote/retired/Packages-$now.adb"
fi
rclone copyto "$work/wasm32/Packages.adb" "$remote/Packages.adb" \
  --header-upload 'Cache-Control: no-cache'

# 3. Drop retired indexes past the grace period, then every package that
# neither the live index nor a remaining retired one names. Retired names sort
# by the time they stopped being live.
cutoff=$(date -u -d "$grace_days days ago" +%Y%m%dT%H%M%SZ)
mkdir "$work/retired"
rclone lsf "$remote/retired" --files-only --include 'Packages-*.adb' >"$work/retired.list"
: >"$work/expired"
while read -r name; do
  stamp=${name#Packages-}
  stamp=${stamp%.adb}
  if [[ $stamp < $cutoff ]]; then
    echo "$name" >>"$work/expired"
  else
    rclone copyto "$remote/retired/$name" "$work/retired/$name" </dev/null
  fi
done <"$work/retired.list"
if [ -s "$work/expired" ]; then
  rclone delete "$remote/retired" --files-from-raw "$work/expired"
fi

{
  index_files "$work/wasm32/Packages.adb"
  for index in "$work"/retired/*.adb; do
    if [ -e "$index" ]; then index_files "$index"; fi
  done
} | sort -u >"$work/keep"
# Every APK uploaded in step 1 is named by the live index, so the listing taken
# before the index swap covers everything prunable.
{ grep '\.apk$' "$work/published" || true; } | sort | comm -23 - "$work/keep" >"$work/unreferenced"
if [ -s "$work/unreferenced" ]; then
  rclone delete "$remote" --files-from-raw "$work/unreferenced"
fi
