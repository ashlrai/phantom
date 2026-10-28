#!/usr/bin/env bash
# Remove the launchd agent, the installed runner, and its libraries.
# The ledger, state, repos, logs, and config stay in place.
set -euo pipefail

dest="$HOME/ashlr-router"
agents="$HOME/Library/LaunchAgents"
unload_plist() {
  local plist=$1
  if command -v launchctl >/dev/null 2>&1 && [[ -f "$plist" ]]; then
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    printf 'uninstall: unloaded %s\n' "$plist"
  fi
  if [[ -f "$plist" ]]; then
    rm -f "$plist"
    printf 'uninstall: removed %s\n' "$plist"
  fi
}
unload_plist "$agents/com.ashlr.router.plist"
unload_plist "$agents/com.ashlr.router.keepalive.plist"
rm -rf "${dest:?}/bin" "${dest:?}/lib"
printf 'uninstall: removed %s/bin and %s/lib\n' "$dest" "$dest"
printf 'uninstall: left ledger, state, repos, logs, and config in %s\n' "$dest"
