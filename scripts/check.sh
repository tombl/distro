#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check.sh [options] [REGEX]

Build flake checks whose attribute name matches REGEX (default: all).

Options:
  -n N              Run every matching check N times.
  --no-overrides    Do not use source checkouts.
  --overrides x,y   Only override the named source checkouts.
  -h, --help        Show this help.
EOF
}

die() {
  printf 'check.sh: %s\n' "$*" >&2
  exit 2
}

regex_matches_empty() {
  [[ '' =~ $1 ]]
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if repo_root=$(git -C "$script_dir/.." rev-parse --show-toplevel 2>/dev/null); then
  :
elif [[ -d $script_dir/../.jj && -f $script_dir/../flake.nix ]]; then
  # Pure jj workspaces have no .git directory for git rev-parse to discover.
  repo_root=$(cd -- "$script_dir/.." && pwd)
else
  die 'could not find the repository root'
fi
cd "$repo_root"

runs=1
override_mode=all
override_option_seen=false
override_selection=
regex=

while (($#)); do
  case $1 in
  -n)
    (($# >= 2)) || die '-n requires a positive integer'
    [[ $2 =~ ^[1-9][0-9]*$ ]] || die '-n requires a positive integer'
    runs=$2
    shift 2
    ;;
  --no-overrides)
    $override_option_seen && die 'use only one of --no-overrides and --overrides'
    override_option_seen=true
    override_mode=none
    shift
    ;;
  --overrides)
    (($# >= 2)) || die '--overrides requires a comma-separated list'
    $override_option_seen && die 'use only one of --no-overrides and --overrides'
    [[ -n $2 ]] || die '--overrides requires a comma-separated list'
    override_option_seen=true
    override_mode=subset
    override_selection=$2
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  --)
    shift
    (($# <= 1)) || die 'expected at most one REGEX'
    if (($#)); then
      regex=$1
    fi
    break
    ;;
  -*)
    die "unknown option: $1"
    ;;
  *)
    [[ -z $regex ]] || die 'expected at most one REGEX'
    regex=$1
    shift
    ;;
  esac
done

if [[ -n $regex ]]; then
  regex_status=0
  regex_matches_empty "$regex" 2>/dev/null || regex_status=$?
  if ((regex_status == 2)); then
    die "invalid regular expression: $regex"
  fi
fi

for command in git jq nix; do
  command -v "$command" >/dev/null || die "required command not found: $command"
done

intent_add_untracked() {
  local directory=$1
  local display_root=$2
  local file display
  local -a untracked=()

  if ! git -C "$directory" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return
  fi

  mapfile -d '' -t untracked < <(
    git -C "$directory" ls-files --others --exclude-standard -z
  )
  ((${#untracked[@]})) || return

  git -C "$directory" add -N -- "${untracked[@]}"
  for file in "${untracked[@]}"; do
    if [[ $display_root == . ]]; then
      display=./$file
    else
      display=$display_root/$file
    fi
    printf 'intent-added: %q\n' "$display"
  done
}

intent_add_untracked . .

declare -a override_args=()
declare -a override_names=()
declare -a override_paths=()
declare -A available_inputs=()

mapfile -t source_inputs < <(
  jq -r '.nodes[.root].inputs | keys[] | select(endswith("-src"))' flake.lock
)
for input in "${source_inputs[@]}"; do
  checkout=${input%-src}
  if [[ -d checkouts/$checkout ]]; then
    available_inputs["$checkout"]=$input
  fi
done

if [[ $override_mode == subset ]]; then
  IFS=, read -r -a requested_overrides <<<"$override_selection"
  declare -A requested_seen=()
  for checkout in "${requested_overrides[@]}"; do
    checkout=${checkout%-src}
    [[ -n $checkout ]] || die '--overrides contains an empty name'
    [[ -n ${available_inputs[$checkout]:-} ]] ||
      die "no checkout-backed flake input found for: $checkout"
    if [[ -z ${requested_seen[$checkout]:-} ]]; then
      requested_seen["$checkout"]=1
      override_names+=("${available_inputs[$checkout]}")
      override_paths+=("./checkouts/$checkout")
    fi
  done
elif [[ $override_mode == all ]]; then
  for input in "${source_inputs[@]}"; do
    checkout=${input%-src}
    if [[ -n ${available_inputs[$checkout]:-} ]]; then
      override_names+=("$input")
      override_paths+=("./checkouts/$checkout")
    fi
  done
fi

for index in "${!override_names[@]}"; do
  input=${override_names[$index]}
  checkout_path=${override_paths[$index]}
  override_args+=(--override-input "$input" "$checkout_path")
  printf 'override: %s -> %s\n' "$input" "$checkout_path"

  intent_add_untracked "$checkout_path" "$checkout_path"

  checkout_head=$(git -C "$checkout_path" rev-parse HEAD 2>/dev/null || true)
  locked_rev=$(
    jq -r --arg input "$input" '
      .nodes[.root].inputs[$input] as $node
      | if ($node | type) == "string"
        then .nodes[$node].locked.rev // empty
        else empty
        end
    ' flake.lock
  )
  if [[ -n $checkout_head && -n $locked_rev && $checkout_head != "$locked_rev" ]]; then
    printf '\n*** WARNING: stale override %s: checkout HEAD %s; flake.lock rev %s ***\n\n' \
      "$input" "$checkout_head" "$locked_rev" >&2
  fi
done

system=$(nix eval --raw --impure --expr builtins.currentSystem)
mtime_key=$(
  stat -c '%y' flake.nix checks.nix | cksum | awk '{ print $1 }'
)
cache_file=${TMPDIR:-/tmp}/linux-wasm-check-names-${UID}-${system}-${mtime_key}
if [[ ! -s $cache_file ]]; then
  cache_tmp=$(mktemp "${cache_file}.XXXXXX")
  if ! nix eval ".#checks.$system" --apply builtins.attrNames --json |
    jq -r '.[]' >"$cache_tmp"; then
    rm -f -- "$cache_tmp"
    exit 1
  fi
  mv -f -- "$cache_tmp" "$cache_file"
fi
mapfile -t all_checks <"$cache_file"

declare -a checks=()
for check in "${all_checks[@]}"; do
  if [[ -z $regex || $check =~ $regex ]]; then
    checks+=("$check")
  fi
done
((${#checks[@]})) || die "no checks match: ${regex:-<all>}"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/linux-wasm-check.XXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT

failure_excerpt() {
  local check=$1
  local iteration=$2
  local drv_path=$3
  local build_log=$4
  local full_log=$tmp_dir/nix-log
  local source_log=$build_log

  if [[ -n $drv_path ]] && NO_COLOR=1 nix log "$drv_path" >"$full_log" 2>&1; then
    source_log=$full_log
  fi

  printf '\n--- %s (iteration %d) failure summary ---\n' "$check" "$iteration"
  sed -E $'s/\033\\[[0-?]*[ -\\/]*[@-~]//g' "$source_log" |
    awk '
      {
        lines[NR] = $0
        if (index($0, "::vm-test::") || index($0, "error:"))
          important[NR] = 1
      }
      END {
        first_tail = NR - 39
        if (first_tail < 1)
          first_tail = 1
        for (line = 1; line <= NR; line++)
          if (important[line] || line >= first_tail)
            print lines[line]
      }
    '
  printf '%s\n' '--- end failure summary ---'
}

declare -A passes=()
declare -A failures=()
for check in "${checks[@]}"; do
  passes["$check"]=0
  failures["$check"]=0
done
total_failures=0

for ((iteration = 1; iteration <= runs; iteration++)); do
  printf '\nIteration %d/%d\n' "$iteration" "$runs"
  for check in "${checks[@]}"; do
    installable=.#checks.$system.$check
    build_log=$tmp_dir/build-${iteration}-${check}.log
    drv_path=$(
      nix path-info --derivation "${override_args[@]}" "$installable" 2>/dev/null |
        head -n 1 || true
    )
    rebuild_args=()
    if nix path-info "${override_args[@]}" "$installable" >/dev/null 2>&1; then
      rebuild_args+=(--rebuild)
      printf 'check: %s (rebuilding existing output)\n' "$check"
    else
      printf 'check: %s (building missing output)\n' "$check"
    fi

    if NO_COLOR=1 nix build --keep-going -L --no-link \
      "${rebuild_args[@]}" "${override_args[@]}" "$installable" 2>&1 |
      tee "$build_log"; then
      passes["$check"]=$((passes[$check] + 1))
    else
      failures["$check"]=$((failures[$check] + 1))
      total_failures=$((total_failures + 1))
      failure_excerpt "$check" "$iteration" "$drv_path" "$build_log"
    fi
  done
done

printf '\nResults\n'
for check in "${checks[@]}"; do
  printf '  %-48s %d pass, %d fail\n' \
    "$check" "${passes[$check]}" "${failures[$check]}"
done

((total_failures == 0))
