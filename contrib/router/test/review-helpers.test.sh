#!/usr/bin/env bash
# Regression checks for issue directives, clean Devin launches and untracked paths.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=router GIT_AUTHOR_EMAIL=router@example.test
export GIT_COMMITTER_NAME=router GIT_COMMITTER_EMAIL=router@example.test
source "$ROOT/lib/claim.sh"
source "$ROOT/lib/env.sh"

checks=0
expect() {
  if [[ "$1" != "$2" ]]; then
    printf 'FAIL %s\n' "$3" >&2
    exit 1
  fi
  checks=$((checks + 1))
}

expect "$(router_body_directive $'description\r\nmodel: \tmodel-name \t\r\ntier:cheap\r\n')" \
  $'model-name\tcheap' 'CRLF directives and model whitespace'
expect "$(router_body_directive $'model: first\nmodel:second\ntier:frontier')" \
  $'second\tfrontier' 'last matching directive without final newline'
expect "$(router_body_directive $'model:  \r\ntier:unknown\r\ntext tier:cheap')" \
  $'\t' 'empty model and unsupported or inline tiers'
expect "$(router_body_directive $'model:name\ntier:workhorse')" \
  $'name\tworkhorse' 'existing LF directive behavior'
expect "$(router_merge_directive label frontier body cheap)" \
  $'label\tfrontier' 'labels retain precedence over body directives'

# Exercise the actual env -i child, including the empty-array path under the
# macOS Bash 3.2 used to launch the router. Values below are synthetic fixtures.
unset DEVIN_API_KEY DEVIN_ORG_ID ROUTER_DEVIN_ORG || true
expect "$(router_exec_devin node -e 'process.stdout.write(JSON.stringify({org:process.env.DEVIN_ORG_ID || "",key:process.env.DEVIN_API_KEY || ""}))')" \
  '{"org":"","key":""}' 'launch without optional Devin values'
ROUTER_DEVIN_ORG=config-org
expect "$(router_exec_devin node -e 'process.stdout.write(process.env.DEVIN_ORG_ID || "")')" \
  config-org 'config-derived Devin org is forwarded'
DEVIN_ORG_ID=environment-org
expect "$(router_exec_devin node -e 'process.stdout.write(process.env.DEVIN_ORG_ID || "")')" \
  environment-org 'environment Devin org takes precedence'
DEVIN_API_KEY=synthetic-fixture
export GITHUB_TOKEN=synthetic-forbidden
expect "$(router_exec_devin node -e 'process.stdout.write(JSON.stringify({org:process.env.DEVIN_ORG_ID,key:process.env.DEVIN_API_KEY,github:process.env.GITHUB_TOKEN || ""}))')" \
  '{"org":"environment-org","key":"synthetic-fixture","github":""}' 'Devin extras preserve the clean environment boundary'
unset DEVIN_API_KEY DEVIN_ORG_ID ROUTER_DEVIN_ORG GITHUB_TOKEN

repo="$tmp/repo"
git init -q -b master "$repo"
printf 'seed\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm seed
base=$(git -C "$repo" rev-parse HEAD)
mkdir -p "$repo/src/new directory"
printf 'new\n' > "$repo/src/new directory/file.txt"
for setting in normal no; do
  git -C "$repo" config status.showUntrackedFiles "$setting"
  expect "$(node "$ROOT/lib/router_io.cjs" stage-list --worktree "$repo" | node -e 'let b="";process.stdin.on("data",x=>b+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(b.split("\0").filter(Boolean))))')" \
    '["src/new directory/file.txt"]' "individual untracked paths with status=$setting"
  node "$ROOT/lib/router_io.cjs" range-check --worktree "$repo" --base "$base"
  checks=$((checks + 1))
done

# Hidden untracked protected files must still be inspected and refused.
mkdir -p "$repo/.github/workflows"
printf 'name: fixture\n' > "$repo/.github/workflows/ci.yml"
if node "$ROOT/lib/router_io.cjs" range-check --worktree "$repo" --base "$base" > "$tmp/denied"; then
  printf 'FAIL hidden protected file accepted\n' >&2
  exit 1
fi
expect "$(cat "$tmp/denied")" '.github/workflows/ci.yml' 'hidden protected files remain denied'
printf 'PASS %s helper regression checks\n' "$checks"
