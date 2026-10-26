#!/usr/bin/env bash
# Tier order and model fallback. A dash means "omit the model flag".

router_next_tier() {
  case "$1" in
    cheap) printf 'workhorse\n' ;;
    workhorse) printf 'frontier\n' ;;
    *) printf '\n' ;;
  esac
}

router_effective_tier() {
  if [[ -n "${1:-}" ]]; then
    printf '%s\n' "$1"
  else
    printf 'workhorse\n'
  fi
}

# Arguments: requested configured listed_csv bad_csv listed_known
# Prints: model_or_dash<TAB>warning
router_resolve_model() {
  local requested=$1
  local configured=$2
  local listed=$3
  local bad=$4
  local known=$5
  local chosen item found
  chosen=$requested
  if [[ -z "$chosen" ]]; then
    chosen=$configured
  fi
  if [[ -z "$chosen" ]]; then
    printf '-\t\n'
    return 0
  fi
  local IFS=','
  for item in $bad; do
    if [[ -n "$item" && "$item" == "$chosen" ]]; then
      printf '%s\t%s\n' "-" "probe rejected ${chosen}; using CLI default"
      return 0
    fi
  done
  if [[ "$known" == "1" || "$known" == "true" ]]; then
    found=0
    for item in $listed; do
      if [[ -n "$item" && "$item" == "$chosen" ]]; then
        found=1
      fi
    done
    if [[ "$found" -eq 0 ]]; then
      printf '%s\t%s\n' "-" "${chosen} is not in the recorded model list; using CLI default"
      return 0
    fi
  fi
  printf '%s\t\n' "$chosen"
}

router_tier_model() {
  local tier=$1
  local cli=$2
  case "${tier}:${cli}" in
    frontier:codex) printf '%s\n' "${ROUTER_TIER_FRONTIER_CODEX:-}" ;;
    frontier:claude) printf '%s\n' "${ROUTER_TIER_FRONTIER_CLAUDE:-}" ;;
    frontier:grok) printf '%s\n' "${ROUTER_TIER_FRONTIER_GROK:-}" ;;
    frontier:ollama) printf '%s\n' "${ROUTER_TIER_FRONTIER_OLLAMA:-}" ;;
    workhorse:codex) printf '%s\n' "${ROUTER_TIER_WORKHORSE_CODEX:-}" ;;
    workhorse:claude) printf '%s\n' "${ROUTER_TIER_WORKHORSE_CLAUDE:-}" ;;
    workhorse:grok) printf '%s\n' "${ROUTER_TIER_WORKHORSE_GROK:-}" ;;
    workhorse:ollama) printf '%s\n' "${ROUTER_TIER_WORKHORSE_OLLAMA:-}" ;;
    cheap:codex) printf '%s\n' "${ROUTER_TIER_CHEAP_CODEX:-}" ;;
    cheap:claude) printf '%s\n' "${ROUTER_TIER_CHEAP_CLAUDE:-}" ;;
    cheap:grok) printf '%s\n' "${ROUTER_TIER_CHEAP_GROK:-}" ;;
    cheap:ollama) printf '%s\n' "${ROUTER_TIER_CHEAP_OLLAMA:-}" ;;
    *) printf '\n' ;;
  esac
}

# Prints the next tier when attempt 1 failed verification. Empty means stop.
router_retry_tier() {
  local verify_rc=$1
  local tier=$2
  local attempt=$3
  local next
  if [[ "$verify_rc" -eq 0 || "$attempt" -ne 1 ]]; then
    printf '\n'
    return 0
  fi
  next=$(router_next_tier "$tier")
  printf '%s\n' "$next"
}
