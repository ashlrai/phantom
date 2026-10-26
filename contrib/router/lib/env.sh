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
  local user lang term tmp host codex_home
  local -a cmd
  user=${USER:-$(id -un)}
  lang=${LANG:-C.UTF-8}
  term=${TERM:-dumb}
  tmp=${TMPDIR:-/tmp}
  cmd=(env -i "PATH=${PATH:-}" "HOME=${HOME}" "USER=${user}" "LANG=${lang}" "TERM=${term}" "TMPDIR=${tmp}")
  while [[ $# -gt 0 && "$1" == *=* ]]; do
    case "$1" in
      OLLAMA_HOST=*)
        host=${1#OLLAMA_HOST=}
        case "$host" in
          127.0.0.1|127.0.0.1:*|localhost|localhost:*) cmd+=("$1") ;;
          *)
            printf 'refusing non-loopback OLLAMA_HOST\n' >&2
            return 1
            ;;
        esac
        shift
        ;;
      npm_config_offline=true)
        cmd+=("$1")
        shift
        ;;
      CODEX_HOME=*)
        # CODEX_HOME selects an account directory. It is not a token or a key.
        codex_home=${1#CODEX_HOME=}
        case "$codex_home" in
          *$'\n'*|*$'\r'*)
            printf 'refusing CODEX_HOME\n' >&2
            return 1
            ;;
          /*)
            cmd+=("$1")
            ;;
          *)
            printf 'refusing relative CODEX_HOME\n' >&2
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
  cmd+=("$@")
  "${cmd[@]}"
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
