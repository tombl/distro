#!/usr/bin/env bash
set -euo pipefail

package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd -- "$package_dir/../.." && pwd)

# The guest test images, shared with packages/linux-guest/tests.
nix build "$repo_dir#linux-guest.checks.tests.assets" --out-link "$package_dir/.assets"

# The VM page imports the built package, so refresh dist against src.
(cd "$repo_dir/packages/linux-guest" && pnpm build)
