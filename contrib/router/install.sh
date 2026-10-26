#!/usr/bin/env bash
# Install the launchd agent. Writes only under ~/Library/LaunchAgents and ~/ashlr-router.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/ashlr-router"
agents="$HOME/Library/LaunchAgents"
plist_dest="$agents/com.ashlr.router.plist"
bin="$dest/bin/ashlr-router"

printf 'install: create %s\n' "$dest"
mkdir -p "$dest/bin" "$dest/lib" "$dest/logs" "$dest/tmp" "$dest/locks" "$dest/repos" "$dest/worktrees" "$agents"

printf 'install: copy runner to %s\n' "$bin"
cp "$here/ashlr-router" "$bin"
chmod +x "$bin"
printf 'install: copy libraries to %s/lib\n' "$dest"
cp "$here/lib/"* "$dest/lib/"
if [[ ! -f "$dest/config.json" ]]; then
  printf 'install: write %s/config.json\n' "$dest"
  cp "$here/config.example.json" "$dest/config.json"
else
  printf 'install: leave existing %s/config.json\n' "$dest"
fi

path_value="${PATH}:/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/.grok/bin"
printf 'install: write %s\n' "$plist_dest"
sed \
  -e "s|__ROUTER_BIN__|${bin}|g" \
  -e "s|__ROUTER_HOME__|${dest}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__PATH__|${path_value}|g" \
  "$here/com.ashlr.router.plist.in" > "$plist_dest"

if ! command -v launchctl >/dev/null 2>&1; then
  printf 'install: launchctl is not available; the plist is written and the agent is not loaded\n'
else
  domain="gui/$(id -u)"
  launchctl bootout "$domain" "$plist_dest" >/dev/null 2>&1 || true
  printf 'install: launchctl bootstrap %s %s\n' "$domain" "$plist_dest"
  launchctl bootstrap "$domain" "$plist_dest"
fi

if [[ "${ASHLR_ROUTER_SKIP_PROBE:-}" == "1" ]]; then
  printf 'install: skip probe\n'
else
  printf 'install: probe --record-only\n'
  env -u ASHLR_ROUTER_HOME -u ASHLR_ROUTER_CONFIG "$bin" probe --record-only \
    || printf 'install: probe failed; the agent is still installed\n'
fi

printf 'install: done\n'
