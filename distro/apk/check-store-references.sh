#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: apk-check-store-references PATH..." >&2
  exit 2
fi

status=0
store_reference='/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-'
for root in "$@"; do
  if grep --recursive --files-with-matches --binary-files=text --extended-regexp \
    "$store_reference" "$root"; then
    status=1
  fi

  while IFS= read -r -d '' link; do
    target=$(readlink "$link")
    if [[ $target =~ $store_reference ]]; then
      printf '%s -> %s\n' "$link" "$target" >&2
      status=1
    fi
  done < <(find "$root" -type l -print0)
done

if [[ $status -ne 0 ]]; then
  echo "APK payload contains Nix store references" >&2
fi
exit "$status"
