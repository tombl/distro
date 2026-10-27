#!/usr/bin/env bash
set -euo pipefail

# Report whether this run's commit is still the newest one for its branch or
# pull request, so a deploy job never publishes over a newer deployment.
# Writes current=true or current=false to $GITHUB_OUTPUT.
#
# Usage: is-current.sh SHA [PULL_REQUEST_NUMBER]

sha="$1"
pull_request="${2:-}"

if [ -n "$pull_request" ]; then
  head="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pull_request}" --jq '.head.sha')"
else
  head="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_REF}" --jq '.sha')"
fi

if [ "$head" = "$sha" ]; then
  echo "current=true" >>"$GITHUB_OUTPUT"
else
  echo "Skipping deploy: ${sha} is no longer the newest commit (now ${head})." >&2
  echo "current=false" >>"$GITHUB_OUTPUT"
fi
