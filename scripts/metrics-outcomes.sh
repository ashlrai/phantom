#!/usr/bin/env bash
# Merged pull requests since a UTC date (default: today), as TSV.
# Requires GitHub CLI access through the operator's approved Locus identity.
set -euo pipefail
since=${1:-$(date -u +%F)}
if [[ $# -gt 1 || ! $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo 'Usage: metrics-outcomes.sh [YYYY-MM-DD]' >&2
  exit 2
fi
repos=(phantom phantom-secrets locus lexicon ashlr-md ashlr-stack ashlr-plugin)
rows='' total=0
for repo in "${repos[@]}"; do
  # Search uses merge time, independent of author, branch or local activity.
  if ! count=$(gh search prs --repo "ashlrai/$repo" --merged ">=$since" \
    --limit 1000 --json number --jq 'length' 2>/dev/null); then
    echo "Merge search failed for ashlrai/$repo" >&2
    exit 1
  fi
  if [[ ! $count =~ ^(0|[1-9][0-9]{0,3})$ ]] || (( count >= 1000 )); then
    echo "Incomplete or invalid merge count for ashlrai/$repo" >&2
    exit 1
  fi
  rows+=$(printf 'ashlrai/%s\t%s' "$repo" "$count")$'\n'
  total=$((total + count))
done
# Publish only after every repository succeeds; failures never look like zero.
printf 'repo\tmerged_since_%s\n%stotal\t%s\n' "$since" "$rows" "$total"
