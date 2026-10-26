#!/usr/bin/env bash
# Headroom pick. Negative scores are excluded. Ties rotate.

router_pick_from_scores() {
  local rotation=$1
  shift
  local best=-1
  local cli score n index i
  local -a tied
  best=-1
  while [[ $# -ge 2 ]]; do
    cli=$1
    score=$2
    shift 2
    if [[ "$score" -lt 0 ]]; then
      continue
    fi
    if [[ "$score" -gt "$best" ]]; then
      best=$score
      tied=("$cli")
    elif [[ "$score" -eq "$best" ]]; then
      tied+=("$cli")
    fi
  done
  n=${#tied[@]}
  if [[ "$n" -eq 0 ]]; then
    return 1
  fi
  index=$((rotation % n))
  i=0
  for cli in "${tied[@]}"; do
    if [[ "$i" -eq "$index" ]]; then
      printf '%s\n' "$cli"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# First configured local model that is already installed. Never selects a
# missing model, because some Ollama builds would download it.
router_pick_local_model() {
  local installed=$1
  local want have
  local IFS=','
  for want in ${ROUTER_LOCAL_MODELS:-}; do
    [[ -n "$want" ]] || continue
    for have in $installed; do
      if [[ "$have" == "$want" ]]; then
        printf '%s\n' "$want"
        return 0
      fi
    done
  done
  return 1
}
