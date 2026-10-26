#!/usr/bin/env bash
# Remove the launchd agent, the installed runner, and its libraries.
# The ledger, state, repos, logs, and config stay in place.
set -euo pipefail

dest="$HOME/ashlr-router"
plist="$HOME/Library/LaunchAgents/com.ashlr.router.plist"

if command -v launchctl >/dev/null 2>&1 && [[ -f "$plist" ]]; then
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  printf 'uninstall: unloaded %s\n' "$plist"
fi
if [[ -f "$plist" ]]; then
  rm -f "$plist"
  printf 'uninstall: removed %s\n' "$plist"
fi
rm -rf "${dest:?}/bin" "${dest:?}/lib"
printf 'uninstall: removed %s/bin and %s/lib\n' "$dest" "$dest"
printf 'uninstall: left ledger, state, repos, logs, and config in %s\n' "$dest"
