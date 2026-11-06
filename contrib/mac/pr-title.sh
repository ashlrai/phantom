#!/bin/bash
# Bash 3.2 compatible. One-line PR title for the external publish.sh:
#   pr-title.sh <job-id> <router-line-file> [diff-file]
# Prints `type(scope): summary` at or under 72 chars, or the job id when no
# better source resolves. Always exits 0 after argument validation.
set -uo pipefail
export LC_ALL=C

fail() { printf 'pr-title: %s\n' "$1" >&2; exit 2; }
[[ $# -ge 2 && $# -le 3 ]] || fail 'usage: pr-title.sh <job-id> <router-line-file> [diff-file]'
job=$1 line_file=$2 diff_file=${3:-}
[[ $job =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$ ]] || fail 'job must be a single safe identifier'

title=

# Optional best effort: the diff goes to a loopback-only local model through
# the checkout's pr-title.mjs. Any failure leaves the router-line fallback.
if [[ -n $diff_file && -r $diff_file && -n ${PHANTOM_ROOT:-} && -f $PHANTOM_ROOT/scripts/pr-title.mjs \
      && -f $PHANTOM_ROOT/dist/core/bridge/pr-title.js ]] && command -v node >/dev/null 2>&1; then
  candidate=$(perl -e 'alarm 45; exec @ARGV' node "$PHANTOM_ROOT/scripts/pr-title.mjs" \
    --job "$job" --diff "$diff_file" --line "$line_file" 2>/dev/null | head -n 1) || candidate=
  if [[ -n $candidate && ${#candidate} -le 72 && $candidate =~ ^[[:print:]]+$ ]]; then
    title=$candidate
  fi
fi

# Deterministic router-line title: JOB (meta): task text -> type(scope): summary.
if [[ -z $title && -r $line_file ]]; then
  title=$(head -n 1 "$line_file" | tr -d '\000-\037\177' | awk '
    function bounded(hay, words) { return hay ~ ("(^| )(" words ")( |$)") }
    {
      line = $0
      gsub(/[[:space:]]+/, " ", line)
      sub(/^ +/, "", line); sub(/ +$/, "", line)
      scope = ""; task = line
      if (match(line, /^[A-Za-z0-9][A-Za-z0-9._-]* \([^()]*\):[ ]*/)) {
        meta = substr(line, RSTART, RLENGTH)
        task = substr(line, RSTART + RLENGTH)
        if (match(meta, /repo=[A-Za-z0-9._-]+/))
          scope = substr(meta, RSTART + 5, RLENGTH - 5)
      }
      sub(/^VISION [^.:;]*[.:;]? /, "", task)
      hay = tolower(" " task " ")
      gsub(/[^a-z0-9]+/, " ", hay)
      if (match(task, /[.!?] /)) task = substr(task, 1, RSTART - 1)
      sub(/[.!? ]+$/, "", task)
      summary = tolower(substr(task, 1, 1)) substr(task, 2)
      if (summary == "") exit
      if (bounded(hay, "fix|bug|bugfix|regression|hotfix|repair|broken|crash")) type = "fix"
      else if (bounded(hay, "test|tests|coverage|vitest|fixture")) type = "test"
      else if (bounded(hay, "doc|docs|document|documentation|readme|guide")) type = "docs"
      else if (bounded(hay, "ci|workflow|pipeline|typecheck|lint|gate")) type = "ci"
      else if (bounded(hay, "refactor|cleanup|simplify|restructure|rename|dedup")) type = "refactor"
      else if (bounded(hay, "perf|performance|optimize|optimise|speed|faster|latency|throughput")) type = "perf"
      else if (bounded(hay, "revert|rollback|back|out")) type = "revert"
      else if (bounded(hay, "deps|dependency|upgrade|bump|package")) type = "build"
      else if (bounded(hay, "add|implement|introduce|support|create|feature|enable|wire|new")) type = "feat"
      else type = "chore"
      title = (scope == "") ? type ": " summary : type "(" scope "): " summary
      if (length(title) > 72) {
        cut = substr(title, 1, 73)
        if (match(cut, / [^ ]*$/)) cut = substr(cut, 1, RSTART - 1)
        else cut = substr(title, 1, 72)
        sub(/[ .,;:!?()\/"'\''`-]+$/, "", cut)
        title = (cut == "") ? substr(title, 1, 72) : cut
      }
      print title
    }') || title=
fi

[[ -n $title ]] || title=$job
printf '%s\n' "$title"
