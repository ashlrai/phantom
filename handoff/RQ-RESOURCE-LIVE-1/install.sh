#!/bin/bash
# install.sh (RQ-RESOURCE-LIVE-1): Security package draft. Installs the ai.ashlr.resource-live LaunchAgent, which runs
# `phm usage resource-live --watch` and keeps <runs>/state/resource-live.json current.
#   install.sh [--apply --pin SHA256] [--phm PATH] [--runs-dir DIR] [--agents-dir DIR]
#     default     dry run: print the rendered plist and the package sha256, write nothing
#     --apply     write the plist and load it. Needs --pin equal to the package sha256 that Security approved.
# Exit 0 = ok, 1 = a step failed, 2 = usage. No network, no sudo. An agent never runs --apply: Security does.
set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
apply=0; pin=; phm=$(command -v phm || true); runs=${ASHLR_RUNS_DIR:-$HOME/.ashlr-runs}; agents=$HOME/Library/LaunchAgents
usage() { echo "usage: install.sh [--apply --pin SHA256] [--phm PATH] [--runs-dir DIR] [--agents-dir DIR]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;;
    --pin|--phm|--runs-dir|--agents-dir)
      [ $# -ge 2 ] || usage
      case $1 in --pin) pin=$2 ;; --phm) phm=$2 ;; --runs-dir) runs=$2 ;; --agents-dir) agents=$2 ;; esac
      shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) usage ;;
  esac
  shift
done
case $runs in /*) ;; *) echo "install.sh: --runs-dir must be absolute" >&2; exit 2 ;; esac
case $runs in */.codex*) echo "install.sh: refusing a runs dir under a Codex home" >&2; exit 2 ;; esac
case $phm in /*) ;; *) echo "install.sh: phm not found; pass --phm /absolute/path" >&2; exit 1 ;; esac

# One sha256 over the files Security reviews, in a fixed order.
package_sha=$(cat "$here/ai.ashlr.resource-live.plist.in" "$here/resource_live_merge.py" "$here/install.sh" | shasum -a 256 | cut -c1-64)
# XML-escape first, then escape what the outer sed replacement would interpret.
esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/[&|\\]/\\&/g'; }
rendered=$(sed -e "s|__PHM__|$(esc "$phm")|g" -e "s|__RUNS_DIR__|$(esc "$runs")|g" -e "s|__HOME__|$(esc "$HOME")|g" \
  -e "s|__PATH__|$(esc "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")|g" "$here/ai.ashlr.resource-live.plist.in") || exit 1
target=$agents/ai.ashlr.resource-live.plist

if [ "$apply" = 0 ]; then
  echo "dry run: would write $target"
  echo "$rendered"
  echo "package sha256=$package_sha"
  exit 0
fi
[ -n "$pin" ] || { echo "install.sh: --apply needs --pin SHA256 from the Security approval" >&2; exit 2; }
[ "$pin" = "$package_sha" ] || { echo "install.sh: pin does not match package sha256=$package_sha" >&2; exit 1; }
[ -d "$agents" ] || { echo "install.sh: $agents is not a directory" >&2; exit 1; }
[ ! -L "$target" ] || { echo "install.sh: refusing symlink destination $target" >&2; exit 1; }
mkdir -p "$runs/logs" "$runs/state" || exit 1
if [ -f "$target" ]; then cp -p "$target" "$target.bak-$(date +%Y%m%d-%H%M%S)" || exit 1; fi
tmp=$target.tmp.$$
printf '%s\n' "$rendered" > "$tmp" && chmod 644 "$tmp" && plutil -lint "$tmp" >/dev/null && mv -f "$tmp" "$target" || { rm -f "$tmp"; exit 1; }
launchctl bootout "gui/$(id -u)/ai.ashlr.resource-live" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$target" || exit 1
echo "installed $target (package sha256=$package_sha)"
