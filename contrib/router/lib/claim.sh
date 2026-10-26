#!/usr/bin/env bash
# Pure claim and directive parsing. Labels are a comma-separated list.

router_claim_comment() {
  printf 'ashlr-router claimed this issue for %s.\n' "$1"
}

router_route_from_labels() {
  local labels=$1
  local item route claimed
  route=""
  claimed=0
  local IFS=','
  for item in $labels; do
    case "$item" in
      route:claimed) claimed=1 ;;
      route:codex|route:claude|route:grok|route:devin) route=${item#route:} ;;
      route:any)
        if [[ -z "$route" ]]; then
          route=any
        fi
        ;;
    esac
  done
  if [[ "$claimed" -eq 1 ]]; then
    printf 'skip\tclaimed\n'
    return 0
  fi
  if [[ -z "$route" ]]; then
    printf 'skip\tunrouted\n'
    return 0
  fi
  printf '%s\n' "$route"
}

# Prints "model<TAB>tier" found in a comma-separated label list.
router_label_directive() {
  local labels=$1
  local item model tier
  model=""
  tier=""
  local IFS=','
  for item in $labels; do
    case "$item" in
      model:*) model=${item#model:} ;;
      tier:frontier|tier:workhorse|tier:cheap) tier=${item#tier:} ;;
    esac
  done
  printf '%s\t%s\n' "$model" "$tier"
}

# Prints "model<TAB>tier" from full lines in the issue body.
router_body_directive() {
  local body=$1
  local line model tier
  model=""
  tier=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      model:*) model=${line#model:} ;;
      tier:frontier|tier:workhorse|tier:cheap) tier=${line#tier:} ;;
    esac
  done <<EOF
$body
EOF
  printf '%s\t%s\n' "$model" "$tier"
}

# Label directives win over body lines. Empty tier stays empty here.
router_merge_directive() {
  local label_model=$1
  local label_tier=$2
  local body_model=$3
  local body_tier=$4
  local model tier
  model=$label_model
  tier=$label_tier
  if [[ -z "$model" ]]; then
    model=$body_model
  fi
  if [[ -z "$tier" ]]; then
    tier=$body_tier
  fi
  printf '%s\t%s\n' "$model" "$tier"
}
