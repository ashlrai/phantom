#!/usr/bin/env bash
# Run the repo test and lint scripts only when dependencies are already installed.

router_verify() {
  local dir=$1
  local scripts script rc
  # Exported so ashlr-router can read the skip reason after this returns.
  ROUTER_VERIFY_WARN=""
  export ROUTER_VERIFY_WARN
  rc=0
  if [[ ! -f "$dir/package.json" ]]; then
    ROUTER_VERIFY_WARN="no package.json; verification skipped"
    export ROUTER_VERIFY_WARN
    return 0
  fi
  if [[ ! -d "$dir/node_modules" ]]; then
    ROUTER_VERIFY_WARN="node_modules absent; verification skipped"
    export ROUTER_VERIFY_WARN
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    ROUTER_VERIFY_WARN="npm not on PATH; verification skipped"
    export ROUTER_VERIFY_WARN
    return 0
  fi
  scripts=$(node "$ROUTER_IO" package-scripts "$dir/package.json")
  while IFS= read -r script; do
    [[ -n "$script" ]] || continue
    if [[ "$script" == "test" ]]; then
      if ! router_exec_clean npm_config_offline=true -- npm --prefix "$dir" test; then
        rc=1
      fi
    elif [[ "$script" == "lint" ]]; then
      if ! router_exec_clean npm_config_offline=true -- npm --prefix "$dir" run lint; then
        rc=1
      fi
    fi
  done <<EOF
$scripts
EOF
  return "$rc"
}
