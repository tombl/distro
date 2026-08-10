#!/usr/bin/env bash
set -euo pipefail

package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd -- "$package_dir/../.." && pwd)

# The guest test root filesystem, shared with the linux-guest tests.
nix build "$repo_dir#linux-guest.checks.tests.assets" --out-link "$package_dir/.assets"

# The VM page imports workspace builds, so refresh their generated assets.
(cd "$repo_dir" && pnpm artifacts && pnpm --filter=@lowland/bytes build && pnpm --filter=@lowland/kernel build && pnpm --filter=@tombl/linux-guest build)
