#!/usr/bin/env bash
# Install and health-check oMLX on a Mac. oMLX is the local OpenAI-compatible
# MLX server. This script never removes an Ollama model unless that model's
# oMLX equivalent is healthy and the user passed --prune-ollama.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
if [[ -f "$here/lib/router_io.cjs" ]]; then
  OMLX_IO=$here/lib/router_io.cjs
elif [[ -f "$here/../lib/router_io.cjs" ]]; then
  OMLX_IO=$here/../lib/router_io.cjs
else
  printf 'omlx helper cannot find router_io.cjs\n' >&2
  exit 1
fi

OMLX_HOST=${OMLX_HOST:-127.0.0.1:8000}
OMLX_FLOOR_GB=${OMLX_FLOOR_GB:-20}

omlx_free_kb() {
  if [[ -n "${OMLX_FREE_KB:-}" ]]; then
    printf '%s\n' "$OMLX_FREE_KB"
    return 0
  fi
  df -k "${HOME}" | awk 'NR==2 { print $4 }'
}

omlx_curl() {
  if [[ -n "${OMLX_CURL:-}" ]]; then
    "$OMLX_CURL" "$@"
    return $?
  fi
  curl -fsS --max-time 30 "$@"
}

omlx_health() {
  node "$OMLX_IO" loopback-ok "$OMLX_HOST"
  omlx_curl "http://${OMLX_HOST}/v1/models" >/dev/null
  printf 'omlx health ok %s\n' "$OMLX_HOST"
}

omlx_model_healthy() {
  local model=$1
  local body payload
  node "$OMLX_IO" loopback-ok "$OMLX_HOST"
  body=$(omlx_curl "http://${OMLX_HOST}/v1/models")
  if ! printf '%s' "$body" | node "$OMLX_IO" omlx-names | grep -Fx -- "$model" >/dev/null; then
    printf 'omlx model is not listed\n' >&2
    return 1
  fi
  payload=$(node -e 'process.stdout.write(JSON.stringify({model:process.argv[1],messages:[{role:"user",content:"Reply with ok"}],max_tokens:8}))' "$model")
  body=$(omlx_curl -X POST "http://${OMLX_HOST}/v1/chat/completions" \
    -H 'content-type: application/json' \
    --data "$payload")
  printf '%s' "$body" | grep -q 'ok\|choices'
}

omlx_download_check() {
  local repo=$1
  local info size free
  case "$repo" in
    */*) ;;
    *)
      printf 'model id must look like owner/name\n' >&2
      return 1
      ;;
  esac
  info=$(omlx_curl "http://${OMLX_HOST}/admin/api/hf/model-info?repo_id=${repo}")
  if ! size=$(printf '%s' "$info" | node "$OMLX_IO" model-size); then
    printf 'model size is unknown; refusing download\n' >&2
    return 1
  fi
  size=$(printf '%s' "$size" | tr -d '\n')
  free=$(omlx_free_kb | tr -d '\n')
  if ! node "$OMLX_IO" disk-allows --free-kb "$free" --size-bytes "$size" --floor-gb "$OMLX_FLOOR_GB"; then
    printf 'refusing download; free disk would drop below %s GB\n' "$OMLX_FLOOR_GB" >&2
    return 1
  fi
  printf 'download allowed\n'
}

omlx_download() {
  local repo=$1
  local payload
  omlx_download_check "$repo"
  payload=$(node -e 'process.stdout.write(JSON.stringify({repo_id:process.argv[1]}))' "$repo")
  omlx_curl -X POST "http://${OMLX_HOST}/admin/api/hf/download" \
    -H 'content-type: application/json' \
    --data "$payload" >/dev/null
  printf 'download started %s\n' "$repo"
}

omlx_prune() {
  local ollama_name=$1
  local model=$2
  if ! omlx_model_healthy "$model"; then
    printf 'omlx model is not healthy; leaving the Ollama model in place\n' >&2
    return 1
  fi
  if [[ -n "${OMLX_OLLAMA:-}" ]]; then
    "$OMLX_OLLAMA" rm "$ollama_name"
  else
    ollama rm "$ollama_name"
  fi
  printf 'removed ollama model %s\n' "$ollama_name"
}

omlx_install() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'omlx install runs on macOS\n' >&2
    return 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    printf 'Homebrew is required to install omlx\n' >&2
    return 1
  fi
  if ! command -v omlx >/dev/null 2>&1; then
    printf 'install: brew install jundot/omlx/omlx\n'
    brew tap jundot/omlx https://github.com/jundot/omlx
    brew install jundot/omlx/omlx
  else
    printf 'install: omlx is already on PATH\n'
  fi
  omlx_start_loopback
  OMLX_HOST=127.0.0.1:8000
  omlx_health
}

omlx_start_loopback() {
  node "$OMLX_IO" loopback-ok "127.0.0.1:8000"
  printf 'install: omlx serve --host 127.0.0.1 --port 8000\n'
  if [[ "${OMLX_SERVE_FOREGROUND:-}" == "1" ]]; then
    omlx serve --host 127.0.0.1 --port 8000
    return $?
  fi
  omlx serve --host 127.0.0.1 --port 8000 >>"${OMLX_SERVE_LOG:-${TMPDIR:-/tmp}/omlx-serve.log}" 2>&1 &
  printf '%s\n' "$!"
}

omlx_main() {
  local cmd=${1:-health}
  case "$cmd" in
    install)
      omlx_install
      ;;
    health)
      omlx_health
      ;;
    download)
      shift
      local check=0 repo
      if [[ "${1:-}" == "--check-only" ]]; then
        check=1
        shift
      fi
      repo=${1:-}
      if [[ -z "$repo" ]]; then
        printf 'usage: omlx-mac.sh download [--check-only] owner/name\n' >&2
        return 2
      fi
      if [[ "$check" -eq 1 ]]; then
        omlx_download_check "$repo"
      else
        omlx_download "$repo"
      fi
      ;;
    --prune-ollama)
      shift
      local name=${1:-} model=""
      shift || true
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --omlx-model)
            model=${2:-}
            shift 2
            ;;
          *)
            printf 'unknown argument %s\n' "$1" >&2
            return 2
            ;;
        esac
      done
      if [[ -z "$name" || -z "$model" ]]; then
        printf 'usage: omlx-mac.sh --prune-ollama <ollama-name> --omlx-model <omlx-id>\n' >&2
        return 2
      fi
      omlx_prune "$name" "$model"
      ;;
    help|-h|--help)
      cat <<'EOF'
usage: omlx-mac.sh <install|health|download|--prune-ollama>

  install                  macOS only. brew install jundot/omlx/omlx, then omlx serve --host 127.0.0.1 --port 8000, then health
  health                   GET http://127.0.0.1:8000/v1/models
  download [--check-only] owner/name
                           refuse when the download would leave less than 20 GB free
  --prune-ollama NAME --omlx-model ID
                           ollama rm only after the oMLX model answers a health check
EOF
      ;;
    *)
      printf 'unknown command %s\n' "$cmd" >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  omlx_main "$@"
fi
