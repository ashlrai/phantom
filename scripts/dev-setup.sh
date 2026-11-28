#!/usr/bin/env bash
# One-command contributor setup for a clean macOS or Linux checkout.
# Installs dependencies, builds, and smokes the in-repo CLI.
# Does not install or replace anything on PATH. Use ./install.sh for that.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

log() { printf 'dev-setup: %s\n' "$*"; }
die() { printf 'dev-setup: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js not found. Install Node 22.15 or newer and retry."
command -v git >/dev/null || die "git not found. Install git and retry."
command -v npm >/dev/null || die "npm not found. Install npm (Node 22.15 or newer) and retry."

node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 15) ? 0 : 1)' \
  || die "Node 22.15 or newer is required; found $(node --version)."

[[ -f package.json ]] || die "package.json not found in ${repo_dir}"
node -e 'const name = JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).name; process.exit(name === "@ashlr/phantom" ? 0 : 1)' \
  || die "this script must be run from an ashlrai/phantom checkout"

SECONDS=0
log "Node $(node --version); npm $(npm --version)"
log "Installing dependencies with npm ci"
npm ci
log "Building"
npm run build
log "Smoking the in-repo CLI"
node bin/ashlr --version
node bin/ashlr --help >/dev/null
log "OK in ${SECONDS}s. Try the CLI with: node bin/ashlr --help"
log "The CLI was not installed globally. Run ./install.sh if you want phm on PATH."
