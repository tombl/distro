#!/usr/bin/env bash
set -euo pipefail

site_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

xterm_version=6
esbuild_specs=(
  "@xterm/xterm@$xterm_version"
  "@xterm/addon-fit@^0.11"
  "@xterm/addon-webgl@^0.19"
)

build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT

cd "$build_dir"
npm init -y >/dev/null
npm install --no-audit --no-fund "${esbuild_specs[@]}"

cat >entry.js <<'EOF'
export { Terminal } from "@xterm/xterm";
export { FitAddon } from "@xterm/addon-fit";
export { WebglAddon } from "@xterm/addon-webgl";
EOF

esbuild entry.js --bundle --format=esm --outfile="$site_dir/vendor/xterm/dist.js"
cp node_modules/@xterm/xterm/css/xterm.css "$site_dir/vendor/xterm/xterm.css"
