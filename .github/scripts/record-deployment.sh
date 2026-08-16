#!/usr/bin/env bash
set -euo pipefail

# Record a GitHub deployment for the current SHA and link its status to the
# URL the deploy jobs just published. GitHub renders these in the pull
# request's Deployments section and the repository's Environments tab.
#
# Usage: record-deployment.sh ENVIRONMENT ENVIRONMENT_URL DESCRIPTION [REF]
#
# REF defaults to $GITHUB_SHA. On pull_request events GITHUB_SHA is the
# synthetic merge commit, which GitHub does not associate with the PR's
# Deployments section; callers must pass the PR head SHA in that case.

environment="$1"
environment_url="$2"
description="${3:-}"
ref="${4:-${GITHUB_SHA:-}}"

# required_contexts must be empty so the deployment is not held pending on
# unrelated checks; auto_merge must be off so the deployment never merges the
# pull request.
payload="$(jq --null-input \
  --arg ref "$ref" \
  --arg environment "$environment" \
  --arg description "$description" \
  '{ ref: $ref, environment: $environment, description: $description, auto_merge: false, required_contexts: [] }')"

deployment_id="$(
  gh api \
    --method POST \
    "repos/${GITHUB_REPOSITORY}/deployments" \
    --input <(printf '%s' "$payload") \
    --jq '.id'
)"

gh api \
  --method POST \
  "repos/${GITHUB_REPOSITORY}/deployments/${deployment_id}/statuses" \
  --input <(jq --null-input \
    --arg state success \
    --arg url "$environment_url" \
    --arg description "$description" \
    '{ state: $state, environment_url: $url, description: $description }') >/dev/null
