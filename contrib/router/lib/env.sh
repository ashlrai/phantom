#!/usr/bin/env bash
# Model CLIs see an allowlisted environment. Tokens and keys are not copied.

router_env_forbidden_name() {
  case "$1" in
    GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|CARGO_REGISTRY_TOKEN) return 0 ;;
    *_TOKEN|*_KEY) return 0 ;;
    *) return 1 ;;
  esac
}

router_clean_env_names() {
  printf '%s\n' PATH HOME USER LANG TERM TMPDIR
}

router_exec_clean() {
  local user lang term tmp host codex_home home path
  local -a cmd extras
  user=${USER:-$(id -un)}
  lang=${LANG:-C.UTF-8}
  term=${TERM:-dumb}
  tmp=${TMPDIR:-/tmp}
  home=${HOME}
  path=${PATH:-}
  extras=()
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    case "$1" in
      HOME=*)
        home=${1#HOME=}
        case "$home" in
          *$'\n'*|*$'\r'*)
            printf 'refusing home for a clean command\n' >&2
            return 1
            ;;
          /*)
            case "$home" in
              *"/.codex"*|*"/.config/gh"*|*"/.ssh"*)
                printf 'refusing home for a clean command\n' >&2
                return 1
                ;;
            esac
            ;;
          *)
            printf 'refusing home for a clean command\n' >&2
            return 1
            ;;
        esac
        shift
        ;;
      PATH=*)
        path=${1#PATH=}
        case "$path" in
          *$'\n'*|*$'\r'*|*"/.codex"*|*"/.config/gh"*|*"/.ssh"*)
            printf 'refusing PATH for a clean command\n' >&2
            return 1
            ;;
        esac
        shift
        ;;
      DEVIN_API_KEY=*|DEVIN_ORG_ID=*)
        extras+=("$1")
        shift
        ;;
      OLLAMA_HOST=*|OMLX_HOST=*)
        host=${1#*=}
        case "$host" in
          127.0.0.1|127.0.0.1:*|localhost|localhost:*) extras+=("$1") ;;
          *)
            printf 'refusing non-loopback model host\n' >&2
            return 1
            ;;
        esac
        shift
        ;;
      npm_config_offline=true)
        extras+=("$1")
        shift
        ;;
      CODEX_HOME=*|CODEX_HOME_ALT=*)
        # These select account directories. They are not tokens or keys.
        codex_home=${1#*=}
        case "$codex_home" in
          *$'\n'*|*$'\r'*)
            printf 'refusing Codex home\n' >&2
            return 1
            ;;
          /*)
            extras+=("$1")
            ;;
          *)
            printf 'refusing relative Codex home\n' >&2
            return 1
            ;;
        esac
        shift
        ;;
      *)
        printf 'refusing extra environment variable for a model command\n' >&2
        return 1
        ;;
    esac
  done
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  cmd=(env -i "PATH=${path}" "HOME=${home}" "USER=${user}" "LANG=${lang}" "TERM=${term}" "TMPDIR=${tmp}")
  if [[ ${#extras[@]} -gt 0 ]]; then
    cmd+=("${extras[@]}")
  fi
  cmd+=("$@")
  "${cmd[@]}"
}

router_exec_devin() {
  local -a extra
  extra=()
  if [[ -n "${DEVIN_API_KEY:-}" ]]; then
    extra+=("DEVIN_API_KEY=${DEVIN_API_KEY}")
  fi
  if [[ -n "${DEVIN_ORG_ID:-}" ]]; then
    extra+=("DEVIN_ORG_ID=${DEVIN_ORG_ID}")
  fi
  router_exec_clean "${extra[@]}" -- "$@"
}

router_format_clean() {
  local user lang term tmp
  user=${USER:-$(id -un)}
  lang=${LANG:-C.UTF-8}
  term=${TERM:-dumb}
  tmp=${TMPDIR:-/tmp}
  printf 'env -i PATH=%q HOME=%q USER=%q LANG=%q TERM=%q TMPDIR=%q' \
    "${PATH:-}" "${HOME}" "$user" "$lang" "$term" "$tmp"
  while [[ $# -gt 0 ]]; do
    printf ' %q' "$1"
    shift
  done
  printf '\n'
}
