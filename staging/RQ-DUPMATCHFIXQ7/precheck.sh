#!/usr/bin/env bash
# precheck.sh: deterministic empty-run precheck, no model call.
# Usage: precheck.sh '<router-queue job line>' <repo-clone-dir>
# Exit 0 = launch the job. Exit 10 = already merged/closed, 11 = PR open and green,
# 12 = duplicate open PR; 75 = retryable/unknown; 64 = invalid job.
# Legacy exit 13 is retired: existence does not establish completion.
# Needs gh (read-only), grep and tr. Prints one outcome receipt.
set -u
line=${1:-}; clone=${2:-}
[ -n "$line" ] || { echo "REJECT code=64 reason=invalid_job"; exit 64; }
[ -e "$clone/.git" ] || { echo "RETRY code=75 reason=clone_unavailable"; exit 75; }
id=$(printf '%s' "$line" | grep -oE 'RQ-[A-Z0-9-]+[A-Z0-9]' | head -1)
repo=$(printf '%s' "$line" | grep -oE '\brepo=[a-z0-9-]+' | head -1 | cut -d= -f2)
[ -n "$id" ] && [ -n "$repo" ] || { echo "REJECT code=64 reason=invalid_job"; exit 64; }
org=${PRECHECK_ORG:-ashlrai}
skip(){ echo "SKIP $id code=$1 reason=$2"; exit "$1"; }
# 1 FIXUP/LAND/CLOSE-DUP target PR state
pr=$(printf '%s' "$line" | grep -oE '(FIXUP|LAND) [a-z0-9-]+ #[0-9]+' | head -1 | grep -oE '[0-9]+$')
# RQ-EMPTY-SHAPE: also 'land https://github.com/<org>/<repo>/pull/N' and RQ-LAND-PRN / RQ-FIXUP-PRN ids
[ -z "$pr" ] && printf '%s' "$id" | grep -qE '^RQ-(LAND|FIXUP)-' && pr=$( { printf '%s\n' "$id" | grep -oE -- '-PR[0-9]+$' | tr -d 'PR-'; printf '%s' "$line" | grep -oE "github\.com/$org/$repo/pull/[0-9]+" | grep -oE '[0-9]+$'; } | head -1)
if [ -n "$pr" ] && [ -n "$repo" ]; then
  vrc=0; st=$(gh pr view "$pr" -R "$org/$repo" --json state,mergeStateStatus,statusCheckRollup \
       -q '.state+" "+.mergeStateStatus+" "+([.statusCheckRollup[]?|(.conclusion // .state)]|map(select(.=="FAILURE" or .=="ERROR" or .=="CANCELLED" or .=="TIMED_OUT"))|length|tostring)' 2>/dev/null) || vrc=$?
  # fail closed: a named target PR we cannot read is UNSURE, not a launch
  [ "$vrc" -ne 0 ] && skip 75 "PRECHECK_UNSURE_pr_$pr"
  case "$st" in
    MERGED*|CLOSED*) skip 10 "pr_${pr}_${st%% *}";;
    "OPEN CLEAN 0") skip 11 "pr_${pr}_green_clean";;
    OPEN\ *) ;;
    *) skip 75 "PRECHECK_UNSURE_pr_$pr";;
  esac
fi
# 2 job id already merged or open as a PR. `gh --search "$id in:title,body"`
# tokenizes the id on '-', so every hit is only a CANDIDATE: a PR counts iff
# its title or body carries the id as a whole [A-Za-z0-9-] token (a '-' never
# delimits, so RQ-RELEASE-TRAIN-1 matches neither RQ-RELTRAIN-1-RETIRE nor
# RQ-RELEASE-TRAIN-1-RETIRE, and -02 never matches -020), or its head branch
# is exactly codex-bridge/<id>. grep -F only; the id is never used as a regex.
# gh failure or unparseable output is UNSURE: fail closed as a possible
# unknown (exit 75, reason=PRECHECK_UNSURE_*) instead of launching blind.
id_in_text() { # $1 = PR title+body; true iff $id is a maximal [A-Za-z0-9-] run
  printf '%s\n' "$1" | tr -cs 'A-Za-z0-9-' '\n' | grep -Fxq -- "$id"
}
dup_pr() { # $1 = open|merged -> prints matching PR number; rc 0 hit / 1 none / 2 unsure
  local tsv num head text h rc2
  case "$1" in open|merged) ;; *) return 2 ;; esac
  tsv=$(gh pr list -R "$org/$repo" --state "$1" --search "$id in:title,body" \
          --json number,title,body,headRefName -q \
          '.[] | [.number, (.headRefName // ""), ((.title // "") + "\n" + (.body // "") | gsub("[\n\t]"; " "))] | @tsv' \
          2>/dev/null) || return 2
  while IFS=$'\t' read -r num head text; do
    case "$num" in
      '') continue ;;
      *[!0-9]*) return 2 ;;   # malformed output row -> UNSURE
    esac
    if [ "$head" = "codex-bridge/$id" ]; then printf '%s\n' "$num"; return 0; fi
    id_in_text "$text"; rc2=$?
    [ "$rc2" -gt 1 ] && return 2   # grep/tr error -> UNSURE
    [ "$rc2" -eq 0 ] && { printf '%s\n' "$num"; return 0; }
  done <<PRECHECK_TSV
$tsv
PRECHECK_TSV
  # the search index never sees headRefName: probe it exactly on its own
  h=$(gh pr list -R "$org/$repo" --state "$1" --head "codex-bridge/$id" --json number -q '.[0].number // empty' 2>/dev/null) || return 2
  case "$h" in
    '') ;;
    *[!0-9]*) return 2 ;;
    *) printf '%s\n' "$h"; return 0 ;;
  esac
  return 1
}
if [ -n "$id" ] && [ -n "$repo" ]; then
  for c in gh tr; do command -v "$c" >/dev/null 2>&1 || skip 75 "PRECHECK_UNSURE_no_$c"; done
  mrc=0; m=$(dup_pr merged) || mrc=$?
  [ "$mrc" -eq 2 ] && skip 75 "PRECHECK_UNSURE_merged"
  [ -n "$m" ] && skip 10 "id_merged_pr_$m"
  orc=0; o=$(dup_pr open) || orc=$?
  if [ -z "$pr" ]; then
    [ "$orc" -eq 2 ] && skip 75 "PRECHECK_UNSURE_open"
    [ -n "$o" ] && skip 12 "id_open_pr_$o"
  fi
fi
# Existing files, tests and symbols are context, never proof of acceptance.
echo "GO $id"; exit 0
