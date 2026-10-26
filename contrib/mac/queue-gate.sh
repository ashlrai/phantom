#!/usr/bin/env bash
# queue-gate.sh: sourced by publish.sh before `gh pr create`.
# Counts queued Actions runs across the core 7 ashlrai repos (read-only).
# Above QUEUE_GATE_THRESHOLD the PR is opened as a draft labeled queue-held.
# Any gh failure fails open: the PR opens normally. Never fails the publish.
#
# Usage in publish.sh:
#   . "$(dirname "$0")/queue-gate.sh"
#   queue_gate_check            # sets QUEUE_GATE_FLAGS ("" or "--draft")
#   gh pr create ... $QUEUE_GATE_FLAGS
#   queue_gate_label "$URL" "$REPO"

: "${QUEUE_GATE_THRESHOLD:=15}"
: "${QUEUE_GATE_ORG:=ashlrai}"
: "${QUEUE_GATE_REPOS:=phantom phantom-secrets locus lexicon ashlr-md ashlr-stack ashlr-plugin}"
QUEUE_GATE_LABEL=queue-held
QUEUE_GATE_HELD=0

# Prints total queued runs, or returns 1 if any lookup failed.
queue_gate_count() {
  local total=0 r n
  for r in $QUEUE_GATE_REPOS; do
    n=$(gh api "repos/$QUEUE_GATE_ORG/$r/actions/runs?status=queued&per_page=1" --jq .total_count 2>/dev/null) || return 1
    case "$n" in ''|*[!0-9]*) return 1 ;; esac
    total=$((total + n))
  done
  echo "$total"
}

# Sets QUEUE_GATE_FLAGS to "--draft" when above the threshold, else "".
queue_gate_check() {
  local c
  QUEUE_GATE_HELD=0
  QUEUE_GATE_FLAGS=""
  if ! c=$(queue_gate_count); then
    echo "queue-gate: WARN gh api failed, opening PR normally" >&2
    return 0
  fi
  if [ "$c" -gt "$QUEUE_GATE_THRESHOLD" ]; then
    QUEUE_GATE_HELD=1
    echo "queue-gate: $c queued > $QUEUE_GATE_THRESHOLD, opening as draft" >&2
    QUEUE_GATE_FLAGS="--draft"
  fi
  return 0
}

# Labels the PR queue-held if the gate drafted it. Never fails.
queue_gate_label() {
  local url=$1 repo=$2
  [ "$QUEUE_GATE_HELD" = 1 ] || return 0
  gh label create "$QUEUE_GATE_LABEL" --repo "$repo" --color BFD4F2 \
    --description "Draft held by queue gate until Actions drains" >/dev/null 2>&1 || true
  gh pr edit "$url" --repo "$repo" --add-label "$QUEUE_GATE_LABEL" >/dev/null 2>&1 \
    || echo "queue-gate: WARN could not label $url" >&2
  return 0
}
