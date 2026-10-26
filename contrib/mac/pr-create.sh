#!/bin/bash
# Bash 3.2 compatible. The caller owns pushing and the Locus-authorized gh context.
set -euo pipefail
export LC_ALL=C

fail() { printf 'pr-create: %s\n' "$1" >&2; exit 1; }
[[ $# == 5 ]] || fail 'usage: pr-create.sh <repo> <fork:branch> <base> <title> <body-file>'
repo=$1 head=$2 base=$3 title=$4 body=$5
[[ $repo =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'repo must be a repository name under ashlrai'
[[ $head =~ ^[A-Za-z0-9][A-Za-z0-9-]*:.+$ ]] || fail 'head must be fork:branch'
git check-ref-format "refs/heads/${head#*:}" >/dev/null 2>&1 || fail 'invalid head branch'
git check-ref-format "refs/heads/$base" >/dev/null 2>&1 || fail 'invalid base branch'
[[ -n $title && -f $body && -r $body ]] || fail 'title and readable body file are required'
# Resolve relative names, including a file named -, without command substitution of content.
body=$(cd -- "$(dirname -- "$body")" && printf '%s/%s' "$PWD" "$(basename -- "$body")")
umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/bridge-pr.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
endpoint="repos/ashlrai/$repo/pulls"

emit_url() {
  local url=$1 number
  number=${url#"https://github.com/ashlrai/$repo/pull/"}
  [[ $number != "$url" && $number =~ ^[1-9][0-9]*$ ]] || fail 'GitHub returned an invalid PR URL; refusing another create'
  printf '%s\n' "$url"
}

reuse_existing() {
  local url
  # gh versions that do not support qualified heads can return an empty list.
  if ! url=$(gh pr list --repo "github.com/ashlrai/$repo" --head "$head" \
    --base "$base" --state open --json url --jq '.[].url' 2>"$scratch/lookup-error"); then
    url=''
  fi
  if [[ -z $url ]]; then
    # REST supports fork:branch and remains usable when GraphQL is unavailable.
    url=$(gh api --hostname github.com --method GET "$endpoint" \
      --raw-field "head=$head" --raw-field "base=$base" --raw-field state=open \
      --jq '.[].html_url' 2>"$scratch/lookup-error") || fail 'cannot check existing PRs; refusing further creation'
  fi
  if [[ -n $url ]]; then emit_url "$url"; exit 0; fi
}

for attempt in 1 2 3; do
  reuse_existing
  if gh pr create --repo "github.com/ashlrai/$repo" --head "$head" --base "$base" \
    --title "$title" --body-file "$body" >"$scratch/output" 2>"$scratch/error"; then
    emit_url "$(cat "$scratch/output")"
    exit 0
  fi
  # Even a permanent error can mean a concurrent invocation already created it.
  reuse_existing
  if ! grep -Eiq 'HTTP[[:space:]]+5[0-9]{2}([^0-9]|$)|GraphQL.*(timed?[ -]?out|timeout)|((timed?[ -]?out|timeout).*[Gg]raphQL)' "$scratch/error"; then
    fail 'gh pr create failed with a non-retryable error; REST create not attempted'
  fi
  if [[ $attempt -lt 3 ]]; then
    delay=$((attempt * 2))
    printf 'pr-create: transient failure on attempt %s/3; retrying in %ss\n' "$attempt" "$delay" >&2
    sleep "$delay"
  fi
done

printf 'pr-create: three transient failures; trying REST create once\n' >&2
reuse_existing
if gh api --hostname github.com --method POST "$endpoint" \
  --raw-field "head=$head" --raw-field "base=$base" --raw-field "title=$title" \
  --field "body=@$body" --jq '.html_url' >"$scratch/output" 2>"$scratch/error"; then
  emit_url "$(cat "$scratch/output")"
  exit 0
fi
# Never repeat a POST whose response might have been lost.
reuse_existing
fail 'REST create failed and no existing PR was found; inspect GitHub before rerunning'
