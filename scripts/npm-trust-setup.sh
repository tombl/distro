#!/usr/bin/env bash
#
# Walks a maintainer through npm trusted publishing for every published
# package (scripts/packages.mjs): claim the names that are not on npm yet,
# trust .github/workflows/ci.yml to publish them, and disallow tokens. Safe to
# re-run; each step skips what is already done.
#
# Run it from anywhere in the repository: scripts/npm-trust-setup.sh
#
# Everything above the "STAGES" marker is a generic wizard library. The
# per-step stages are below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold)
  DIM=$(tput dim)
  RESET=$(tput sgr0)
  BLUE=$(tput setaf 4)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
else
  BOLD=""
  DIM=""
  RESET=""
  BLUE=""
  GREEN=""
  YELLOW=""
fi

# run_wizard sets this before the first stage.
TOTAL_STAGES=0

_STAGE_INDEX=0
SKIPPED=() # steps that failed or were declined, for the summary

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1 && tput clear 2>/dev/null; then return 0; fi
  printf '\033[2J\033[3J\033[H'
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do.\n' "$DIM"
  printf '  Stop any time with Ctrl-C and re-run later: every step skips what is\n'
  printf '  already done.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say() { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  {
    if command -v wslview >/dev/null 2>&1; then
      wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then
      explorer.exe "$url"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url"
    elif command -v open >/dev/null 2>&1; then
      open "$url"
    else false; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ $reply =~ ^[Yy] ]]
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  if ((${#SKIPPED[@]})); then
    printf '\n'
    warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: one stage() per step the human takes. Every stage stays inside
# run_wizard and the last line stays as is: bash then parses the whole file
# before the first prompt, so an edit mid-run can't break it.
# ──────────────────────────────────────────────────────────────────────────

# The release job in .github/workflows/ci.yml publishes these packages with
# npm trusted publishing (OIDC, no token) and runs in no GitHub environment,
# so the trust relationship needs no --env.
REPO="tombl/distro"
WORKFLOW="ci.yml"
NPM_USER="tombl"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
packages=$(node scripts/packages.mjs | jq --raw-output '.[].name')
[[ -n $packages ]] || {
  echo "scripts/packages.mjs lists no published packages" >&2
  exit 1
}
mapfile -t PACKAGES <<<"$packages"

# exists PKG succeeds when PKG has any version on the registry.
exists() { npm view "$1" version >/dev/null 2>&1; }

# trust PKG prints "ok" when one of PKG's trusted publishers is exactly the
# release job (GitHub Actions, $REPO, $WORKFLOW, no environment, allowed to
# publish), "other" when PKG has only different ones, and "none" otherwise.
# `npm trust list --json` prints one JSON object per configuration.
trust() {
  local out
  out=$(npm trust list "$1" --json 2>/dev/null) || {
    echo none
    return
  }
  jq --slurp --raw-output --arg repo "$REPO" --arg file "$WORKFLOW" '
    map(select(type == "object" and has("id"))) as $configs
    | if any($configs[]; .type == "github" and .repository == $repo and .file == $file
        and (.environment // "") == "" and ((.permissions // []) | index("createPackage")))
      then "ok"
      elif ($configs | length) > 0 then "other"
      else "none" end
  ' <<<"$out" 2>/dev/null || echo none
}

run_wizard() {

  TOTAL_STAGES=6

  banner "Lowland npm release setup"

  # ── 1 ─────────────────────────────────────────────────────────────────────
  stage "Preflight"
  say "Checks the local npm CLI and shows where each package stands on npm."
  command -v npm >/dev/null 2>&1 || {
    warn "npm is not on PATH; install Node 24+ and re-run"
    exit 1
  }
  npm_version=$(npm --version)
  if [[ "$(printf '%s\n' 11.15.0 "$npm_version" | sort -V | head -n1)" != 11.15.0 ]]; then
    warn "npm $npm_version is too old for 'npm trust' (needs 11.15.0+)"
    say "Run: npm install --global npm@^11.15.0, then re-run this wizard."
    exit 1
  fi
  note "npm $npm_version"
  note "trust target: github.com/$REPO, .github/workflows/$WORKFLOW, no environment"
  for pkg in "${PACKAGES[@]}"; do
    if exists "$pkg"; then
      note "  $pkg: on npm ($(npm view "$pkg" version 2>/dev/null))"
    else note "  $pkg: not on npm yet"; fi
  done
  pause

  # ── 2 ─────────────────────────────────────────────────────────────────────
  stage "Log in to npm"
  current_user=$(npm whoami 2>/dev/null || true)
  if [[ $current_user == "$NPM_USER" ]]; then
    say "Already logged in as $NPM_USER."
  else
    [[ -n $current_user ]] && warn "logged in as $current_user, not $NPM_USER"
    say "npm will print a login URL and wait. Approve it in the browser,"
    say "including the 2FA prompt, then come back here."
    pause "Press Enter to run 'npm login --auth-type=web'"
    npm login --auth-type=web || true
    current_user=$(npm whoami 2>/dev/null || true)
    if [[ $current_user != "$NPM_USER" ]]; then
      warn "npm whoami says '${current_user:-nobody}', expected $NPM_USER; re-run the wizard"
      exit 1
    fi
  fi
  printf '  %s✓ logged in as%s %s\n' "$GREEN" "$RESET" "$current_user"
  pause

  # ── 3 ─────────────────────────────────────────────────────────────────────
  stage "Claim new packages"
  say "npm trust only configures packages that already exist. This publishes a"
  say "bare 0.0.0 placeholder of each published package that is not on npm yet;"
  say "the first release replaces it as latest."
  missing=()
  for pkg in "${PACKAGES[@]}"; do
    if exists "$pkg"; then
      printf '  %s✓ already on npm%s %s\n' "$GREEN" "$RESET" "$pkg"
    else missing+=("$pkg"); fi
  done
  if ((! ${#missing[@]})); then
    pause
  elif confirm "Publish ${missing[*]} at 0.0.0 now? (versions can't be reused)"; then
    say "npm may print a URL for 2FA. Approve it in the browser."
    for pkg in "${missing[@]}"; do
      placeholder=$(mktemp -d)
      jq --null-input --arg name "$pkg" '{name: $name, version: "0.0.0"}' >"$placeholder/package.json"
      if (cd "$placeholder" && npm publish --access public); then
        printf '  %s✓ published%s %s@0.0.0\n' "$GREEN" "$RESET" "$pkg"
      else
        SKIPPED+=("publish the $pkg placeholder (npm publish failed)")
        warn "publish failed; the trust step will skip $pkg"
      fi
      rm -rf "$placeholder"
    done
    pause
  else
    SKIPPED+=("publish placeholders for ${missing[*]} (declined)")
    warn "skipped; the trust step will skip ${missing[*]}"
    pause
  fi

  # ── 4 ─────────────────────────────────────────────────────────────────────
  stage "Trusted publishers"
  say "Lets $REPO's $WORKFLOW publish each package over OIDC."
  step "The first npm trust call asks for 2FA in the browser. Tick the option"
  step "to skip two-factor authentication for 5 minutes, so the rest go through."
  pause "Press Enter to configure ${#PACKAGES[@]} packages"
  for pkg in "${PACKAGES[@]}"; do
    if ! exists "$pkg"; then
      SKIPPED+=("trusted publisher for $pkg (package not on npm)")
      warn "$pkg is not on npm; skipped"
      continue
    fi
    case $(trust "$pkg") in
    ok)
      printf '  %s✓ already trusted%s %s\n' "$GREEN" "$RESET" "$pkg"
      continue
      ;;
    other)
      SKIPPED+=("$pkg trusts something else (another repository, workflow or environment, or staged publishing only): npm trust list $pkg, then npm trust revoke --id <id> $pkg, and re-run")
      warn "$pkg has a trusted publisher the release job can't use; left alone"
      continue
      ;;
    esac
    if npm trust github "$pkg" --file "$WORKFLOW" --repo "$REPO" --allow-publish --yes; then
      printf '  %s✓ trusted%s %s\n' "$GREEN" "$RESET" "$pkg"
    else
      SKIPPED+=("trusted publisher for $pkg (npm trust github failed)")
      warn "npm trust github failed for $pkg"
    fi
    sleep 2
  done
  pause

  # ── 5 ─────────────────────────────────────────────────────────────────────
  stage "Lock down publishing"
  say "With trusted publishing in place, tokens are no longer needed. This sets"
  say "each package to require 2FA and disallow tokens (npm access set mfa=publish)."
  say "OIDC publishes from CI keep working under this setting."
  pause "Press Enter to apply it to ${#PACKAGES[@]} packages"
  for pkg in "${PACKAGES[@]}"; do
    exists "$pkg" || {
      warn "$pkg is not on npm; skipped"
      continue
    }
    if npm access set mfa=publish "$pkg"; then
      printf '  %s✓ locked%s %s\n' "$GREEN" "$RESET" "$pkg"
    else
      SKIPPED+=("lock down $pkg: Settings → Publishing access → Require two-factor authentication and disallow tokens")
      warn "npm access failed for $pkg; set it on the settings page instead"
    fi
  done
  step "Check one package's Settings page. Under Publishing access, 'Require"
  step "two-factor authentication and disallow tokens' should be selected, and"
  step "Trusted Publisher should show GitHub Actions, $REPO, $WORKFLOW."
  open_url "https://www.npmjs.com/package/lowland/access"
  if ! confirm "Does the settings page match?"; then
    SKIPPED+=("fix publishing access by hand on each package's Settings page")
  fi

  # ── 6 ─────────────────────────────────────────────────────────────────────
  stage "Verify"
  for pkg in "${PACKAGES[@]}"; do
    state=$(trust "$pkg")
    if [[ $state == ok ]]; then
      printf '  %s✓%s %s: on npm, trusted publisher set\n' "$GREEN" "$RESET" "$pkg"
    elif [[ $state == other ]]; then
      warn "$pkg: its trusted publisher is not $REPO's $WORKFLOW without an environment"
    elif exists "$pkg"; then
      warn "$pkg: on npm, but no trusted publisher"
    else
      warn "$pkg: not on npm"
    fi
  done
  say ""
  say "Next release: once the PRs land, run 'pnpm release minor' on a clean main."
  say "It bumps every package to one version, tags it, and CI publishes them."
  pause

  finish
}

run_wizard "$@"
exit
