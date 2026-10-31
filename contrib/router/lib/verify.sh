#!/usr/bin/env bash
# Host verification is off unless the config opts in. Draft PR CI is the check.
# An opted-in run uses a throwaway HOME and an allowlisted PATH.

router_verify() {
  local dir=$1
  ROUTER_VERIFY_WARN=""
  export ROUTER_VERIFY_WARN
  if [[ "${ROUTER_HOST_VERIFY:-0}" != "1" ]]; then
    ROUTER_VERIFY_WARN="host verification skipped; draft PR CI is the check"
    export ROUTER_VERIFY_WARN
    return 0
  fi
  router_verify_isolated "$dir"
}

router_verify_isolated() {
  local dir=$1
  local scripts script rc home path_allow node_bin npm_bin
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
  if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
    ROUTER_VERIFY_WARN="npm not on PATH; verification skipped"
    export ROUTER_VERIFY_WARN
    return 0
  fi
  node_bin=$(command -v node)
  npm_bin=$(command -v npm)
  path_allow="$(dirname "$npm_bin"):$(dirname "$node_bin"):/usr/bin:/bin"
  home=$(mktemp -d "${TMPDIR:-/tmp}/router-verify.XXXXXX")
  case "$home" in
    "${TMPDIR:-/tmp}/router-verify."*) ;;
    *) return 1 ;;
  esac
  # The EXIT trap stays inside this subshell so the caller's trap is unchanged.
  (
    trap 'rm -rf "$home"' EXIT
    rc=0
    scripts=$(node "$ROUTER_IO" package-scripts "$dir/package.json")
    while IFS= read -r script; do
      [[ -n "$script" ]] || continue
      if [[ "$script" == "test" ]]; then
        if ! router_exec_clean "HOME=${home}" "PATH=${path_allow}" npm_config_offline=true -- "$npm_bin" --prefix "$dir" test; then
          rc=1
        fi
      elif [[ "$script" == "lint" ]]; then
        if ! router_exec_clean "HOME=${home}" "PATH=${path_allow}" npm_config_offline=true -- "$npm_bin" --prefix "$dir" run lint; then
          rc=1
        fi
      fi
    done <<EOF
$scripts
EOF
    printf '%s\n' "$rc" > "$home.rc"
  )
  rc=$(tr -d '\n' < "$home.rc" 2>/dev/null || printf '1')
  rm -f "$home.rc"
  if [[ -d "$home" ]]; then
    rm -rf "$home"
  fi
  [[ "$rc" =~ ^[0-9]+$ ]] || rc=1
  return "$rc"
}
