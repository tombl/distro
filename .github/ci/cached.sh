#!/usr/bin/env bash
# Succeeds when every store path given as an argument is already in the
# linuxwasm binary cache. A check only has outputs once it has passed, so a
# cached check output means the identical derivation already passed.
set -euo pipefail

# The inner script expands its own positional argument.
# shellcheck disable=SC2016
printf '%s\n' "$@" |
  xargs --no-run-if-empty --max-procs 16 -I '{}' sh -c '
    hash=$(basename "$1" | cut -c1-32)
    curl --fail --silent --head --retry 3 \
      "https://linuxwasm.cachix.org/$hash.narinfo" >/dev/null
  ' sh '{}'
