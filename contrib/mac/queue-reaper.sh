#!/usr/bin/env bash
# queue-reaper.sh: un-drafts queue-held PRs once Actions has drained.
# Safe for cron/launchd every 5 min: idempotent, a lock prevents overlap,
# no model turns. Flags: --dry-run.
set -u
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/queue-gate.sh"
: "${QUEUE_REAPER_BATCH:=3}"
: "${QUEUE_REAPER_P0_EXTRA:=ashlrai/locus#217}"
: "${QUEUE_REAPER_STATE:=$HOME/.queue-reaper}"
mkdir -p "$QUEUE_REAPER_STATE"
P0_LOG="$QUEUE_REAPER_STATE/p0-undrafted.txt"
touch "$P0_LOG"
LOCK="$QUEUE_REAPER_STATE/lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "reaper: already running"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

c=$(queue_gate_count) || { echo "reaper: WARN gh api failed, skipping"; exit 0; }
if [ "$c" -gt "$QUEUE_GATE_THRESHOLD" ]; then
  echo "reaper: $c queued > $QUEUE_GATE_THRESHOLD, holding"; exit 0
fi

# Is any P0 PR we un-drafted still pending or failing? (failing or pending
# checks, or an unreadable state, count as not green)
p0_blocking() {
  local line repo num out keep=""
  while read -r repo num; do
    [ -n "$repo" ] || continue
    st=$(gh pr view "$num" --repo "$repo" --json state --jq .state 2>/dev/null) || { keep="$keep$repo $num"$'\n'; continue; }
    [ "$st" = OPEN ] || continue
    out=$(gh pr checks "$num" --repo "$repo" --json bucket --jq '[.[].bucket] | map(select(. == "pending" or . == "fail")) | length' 2>/dev/null) || out=1
    keep="$keep$repo $num"$'\n'
    [ "${out:-1}" = 0 ] || BLOCK=1
  done < "$P0_LOG"
  printf '%s' "$keep" > "$P0_LOG"
}

# Collect candidates: "p0flag createdAt repo number title"
cands=""
for r in $QUEUE_GATE_REPOS; do
  out=$(gh pr list --repo "$QUEUE_GATE_ORG/$r" --state open --label "$QUEUE_GATE_LABEL" \
    --json number,title,createdAt,isDraft,labels \
    --jq '.[] | [.number, .createdAt, .isDraft, .title, ([.labels[].name] | join(","))] | @tsv' 2>/dev/null) \
    || { echo "reaper: WARN list failed for $r"; continue; }
  while IFS=$'\t' read -r num created draft title labels; do
    [ -n "$num" ] || continue
    p0=1
    if printf '%s %s' "$title" "$labels" | grep -qiE 'MEMORY|ALIVE|DRIVER' \
       || printf ' %s ' "$QUEUE_REAPER_P0_EXTRA" | grep -q " $QUEUE_GATE_ORG/$r#$num "; then p0=0; fi
    cands="$cands$p0 $created $QUEUE_GATE_ORG/$r $num $draft"$'\n'
  done <<< "$out"
done

BLOCK=0
p0_blocking
done_n=0
while read -r p0 created repo num draft; do
  [ -n "$num" ] || continue
  [ "$done_n" -lt "$QUEUE_REAPER_BATCH" ] || break
  if [ "$p0" = 1 ] && [ "$BLOCK" = 1 ]; then
    echo "reaper: hold $repo#$num (P0 checks pending)"; continue
  fi
  if [ "$DRY" = 1 ]; then
    echo "reaper: DRY would ready $repo#$num (p0=$((1-p0)))"
  else
    if [ "$draft" = true ]; then
      gh pr ready "$num" --repo "$repo" >/dev/null 2>&1 || { echo "reaper: WARN ready failed $repo#$num"; continue; }
    fi
    gh pr edit "$num" --repo "$repo" --remove-label "$QUEUE_GATE_LABEL" >/dev/null 2>&1 || true
    [ "$p0" = 0 ] && echo "$repo $num" >> "$P0_LOG"
    echo "reaper: ready $repo#$num (p0=$((1-p0)))"
  fi
  done_n=$((done_n + 1))
done <<< "$(printf '%s' "$cands" | sort -k1,1n -k2,2)"
exit 0
