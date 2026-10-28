#!/usr/bin/env bash
# Install the launchd agent. Writes only under ~/Library/LaunchAgents and ~/ashlr-router.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/ashlr-router"
agents="$HOME/Library/LaunchAgents"
plist_dest="$agents/com.ashlr.router.plist"
keep_dest="$agents/com.ashlr.router.keepalive.plist"
bin="$dest/bin/ashlr-router"

printf 'install: create %s\n' "$dest"
mkdir -p "$dest/bin" "$dest/lib" "$dest/logs" "$dest/tmp" "$dest/locks" "$dest/repos" "$dest/worktrees" "$agents"

printf 'install: copy runner to %s\n' "$bin"
cp "$here/ashlr-router" "$bin"
chmod +x "$bin"
printf 'install: copy libraries to %s/lib\n' "$dest"
cp "$here/lib/"* "$dest/lib/"
printf 'install: copy oMLX helper to %s/bin/omlx-mac.sh\n' "$dest"
cp "$here/omlx-mac.sh" "$dest/bin/omlx-mac.sh"
chmod +x "$dest/bin/omlx-mac.sh"
if [[ ! -f "$dest/config.json" ]]; then
  printf 'install: write %s/config.json\n' "$dest"
  cp "$here/config.example.json" "$dest/config.json"
else
  printf 'install: leave existing %s/config.json\n' "$dest"
fi

path_value="${PATH}:/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/.grok/bin"
org_value=""
if [[ -n "${DEVIN_ORG_ID:-}" ]]; then
  if node "$here/lib/router_io.cjs" devin-org --value "$DEVIN_ORG_ID"; then
    org_value=$DEVIN_ORG_ID
    printf 'install: pass DEVIN_ORG_ID into the launchd environment\n'
  else
    printf 'install: DEVIN_ORG_ID is invalid; not written\n'
  fi
fi
write_plist() {
  local src=$1
  local dest_plist=$2
  printf 'install: write %s\n' "$dest_plist"
  sed \
    -e "s|__ROUTER_BIN__|${bin}|g" \
    -e "s|__ROUTER_HOME__|${dest}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|${path_value}|g" \
    "$src" > "$dest_plist"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const org = process.argv[2] || "";
    let text = fs.readFileSync(file, "utf8");
    if (org) text = text.replace("__DEVIN_ORG_ID__", org);
    else text = text.replace(/\n    <key>DEVIN_ORG_ID<\/key>\n    <string>__DEVIN_ORG_ID__<\/string>\n/, "\n");
    fs.writeFileSync(file, text);
  ' "$dest_plist" "$org_value"
}
write_plist "$here/com.ashlr.router.plist.in" "$plist_dest"
write_plist "$here/com.ashlr.router.keepalive.plist.in" "$keep_dest"

if [[ "${ASHLR_ROUTER_STUB_SIDE_EFFECTS:-}" == "1" ]]; then
  printf 'install: side effects stubbed\n'
elif ! command -v launchctl >/dev/null 2>&1; then
  printf 'install: launchctl is not available; the plists are written and the agents are not loaded\n'
else
  domain="gui/$(id -u)"
  launchctl bootout "$domain" "$plist_dest" >/dev/null 2>&1 || true
  launchctl bootout "$domain" "$keep_dest" >/dev/null 2>&1 || true
  printf 'install: launchctl bootstrap %s %s\n' "$domain" "$plist_dest"
  launchctl bootstrap "$domain" "$plist_dest"
  printf 'install: launchctl bootstrap %s %s\n' "$domain" "$keep_dest"
  launchctl bootstrap "$domain" "$keep_dest"
fi

if [[ "${ASHLR_ROUTER_STUB_SIDE_EFFECTS:-}" == "1" || "${ASHLR_ROUTER_SKIP_PROBE:-}" == "1" ]]; then
  printf 'install: skip probe\n'
else
  printf 'install: probe --record-only\n'
  env -u ASHLR_ROUTER_HOME -u ASHLR_ROUTER_CONFIG "$bin" probe --record-only \
    || printf 'install: probe failed; the agent is still installed\n'
fi

printf 'install: done\n'
