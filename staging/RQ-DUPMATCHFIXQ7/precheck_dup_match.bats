#!/usr/bin/env bats
# precheck_dup_match.bats — fixture tests for precheck.sh exact-id duplicate
# matching (RQ-DUPMATCHFIXQ7 + SPEC-AMEND Security #1).
#
# gh is a PATH stub that serves fixture JSON and applies -q/--jq programs with
# the system jq (gojq-compatible). git runs for real against an empty .git
# marker; no provider or GitHub access occurs.
# No network, no real home, no real gh auth.

PRECHECK=${PRECHECK:-"$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/precheck.sh"}

setup() {
  TMPD=$(mktemp -d)
  mkdir -p "$TMPD/bin" "$TMPD/clone/.git"
  cat > "$TMPD/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Fixture gh: emulates `pr list`/`pr view` incl. -q via jq.
# GH_FAIL_STATE=open|merged -> exit 1 for that --state; GH_FAIL_VIEW=1 -> view exits 1.
# GH_GARBAGE=1 -> emit a malformed row instead of applying -q.
set -u
verb=""; prog=""; state=""; head=""; prev=""
for a in "$@"; do
  case "$prev" in
    -q|--jq) prog=$a ;;
    --state) state=$a ;;
    --head) head=$a ;;
  esac
  case "$a" in list|view) [ -z "$verb" ] && verb=$a ;; esac
  prev=$a
done
[ "$verb" = view ] && [ "${GH_FAIL_VIEW:-0}" = 1 ] && { echo "gh: boom" >&2; exit 1; }
[ "$verb" = list ] && [ "$state" = "${GH_FAIL_STATE:-none}" ] && { echo "gh: boom" >&2; exit 1; }
case "$verb" in
  view) json=${GH_JSON_VIEW:-'{}'} ;;
  list)
    if [ -n "$head" ]; then
      if [ "$state" = merged ]; then json=${GH_JSON_HEAD_MERGED:-${GH_JSON_HEAD:-'[]'}}
      else json=${GH_JSON_HEAD_OPEN:-${GH_JSON_HEAD:-'[]'}}; fi
    elif [ "$state" = merged ]; then json=${GH_JSON_MERGED:-'[]'}
    else json=${GH_JSON_OPEN:-'[]'}; fi ;;
  *) echo "gh stub: unhandled $*" >&2; exit 3 ;;
esac
if [ "${GH_GARBAGE:-0}" = 1 ]; then printf 'GARBAGE-ROW\n'; exit 0; fi
if [ -n "$prog" ]; then printf '%s' "$json" | jq -r "$prog"; else printf '%s\n' "$json"; fi
STUB
  chmod +x "$TMPD/bin/gh"
  export PATH="$TMPD/bin:$PATH" TMPD
  # default: every gh probe answers "nothing"
  export GH_JSON_OPEN='[]' GH_JSON_MERGED='[]' GH_JSON_HEAD='[]'
  unset GH_JSON_VIEW GH_FAIL_STATE GH_FAIL_VIEW GH_GARBAGE GH_JSON_HEAD_OPEN GH_JSON_HEAD_MERGED 2>/dev/null || true
}

teardown() { rm -rf "$TMPD"; }

run_pc() { # $1 = job line
  run bash "$PRECHECK" "$1" "$TMPD/clone"
}

JOB_RTRAIN='RQ-RELEASE-TRAIN-1 (P0, pool=devin, tier=mid, repo=phantom) do thing'
JOB_GEN02='RQ-GEN-2026102703-02 (P1, pool=devin, repo=phantom) gen task'
JOB_GEN020='RQ-GEN-2026102703-020 (P1, pool=devin, repo=phantom) gen task'
JOB_LOOP='RQ-LOOP-1 (P1, pool=devin, repo=phantom) loop task'

@test "fuzzy-only open hit (RQ-RELTRAIN-1-RETIRE) does not skip RQ-RELEASE-TRAIN-1" {
  export GH_JSON_OPEN='[{"number":1322,"title":"bridge(RQ-RELTRAIN-1-RETIRE): notes","body":"retire the train","headRefName":"codex-bridge/RQ-RELTRAIN-1-RETIRE"}]'
  run_pc "$JOB_RTRAIN"
  [ "$status" -eq 0 ]; [[ "$output" == "GO RQ-RELEASE-TRAIN-1" ]]
}

@test "hyphen-suffixed id (RQ-RELEASE-TRAIN-1-RETIRE) does not match" {
  export GH_JSON_OPEN='[{"number":9,"title":"bridge(RQ-RELEASE-TRAIN-1-RETIRE): notes","body":"","headRefName":"codex-bridge/RQ-RELEASE-TRAIN-1-RETIRE"}]'
  run_pc "$JOB_RTRAIN"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "exact id token in open PR title skips with code 12" {
  export GH_JSON_OPEN='[{"number":954,"title":"feat: RQ-LOOP-1 done elsewhere","body":"","headRefName":"feature/other"}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 12 ]; [[ "$output" == *"reason=id_open_pr_954"* ]]
}

@test "exact id token in open PR body skips with code 12" {
  export GH_JSON_OPEN='[{"number":955,"title":"unrelated title","body":"covers RQ-LOOP-1 acceptance","headRefName":"feature/other"}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 12 ]; [[ "$output" == *"reason=id_open_pr_955"* ]]
}

@test "headRefName codex-bridge/<id> skips even without title/body token" {
  export GH_JSON_HEAD_OPEN='[{"number":77}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 12 ]; [[ "$output" == *"reason=id_open_pr_77"* ]]
}

@test "merged codex-bridge/<id> head skips 10 even without title/body token" {
  export GH_JSON_HEAD_MERGED='[{"number":78}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 10 ]; [[ "$output" == *"reason=id_merged_pr_78"* ]]
}

@test "headRefName codex-bridge/<id>-suffix does not match" {
  # candidate whose head differs only by suffix, no id token anywhere
  export GH_JSON_OPEN='[{"number":88,"title":"other","body":"","headRefName":"codex-bridge/RQ-LOOP-1-EXTRA"}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "merged exact id skips with code 10" {
  export GH_JSON_MERGED='[{"number":111,"title":"bridge(RQ-LOOP-1): landed","body":"","headRefName":"codex-bridge/RQ-LOOP-1"}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 10 ]; [[ "$output" == *"reason=id_merged_pr_111"* ]]
}

@test "merged fuzzy-only hit does not skip" {
  export GH_JSON_MERGED='[{"number":111,"title":"bridge(RQ-LOOP-1-EXTRA): landed","body":"","headRefName":"codex-bridge/RQ-LOOP-1-EXTRA"}]'
  run_pc "$JOB_LOOP"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "RQ-GEN-2026102703-02 vs -020 title: no match" {
  export GH_JSON_OPEN='[{"number":5,"title":"bridge(RQ-GEN-2026102703-020): x","body":"","headRefName":"codex-bridge/RQ-GEN-2026102703-020"}]'
  run_pc "$JOB_GEN02"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "RQ-GEN-2026102703-020 vs -02 title: no match (either way)" {
  export GH_JSON_OPEN='[{"number":5,"title":"bridge(RQ-GEN-2026102703-02): x","body":"","headRefName":"codex-bridge/RQ-GEN-2026102703-02"}]'
  run_pc "$JOB_GEN020"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "gh open-list failure fails closed: code 75 PRECHECK_UNSURE" {
  export GH_FAIL_STATE=open
  run_pc "$JOB_LOOP"
  [ "$status" -eq 75 ]; [[ "$output" == *"reason=PRECHECK_UNSURE_open"* ]]
}

@test "gh merged-list failure fails closed first: PRECHECK_UNSURE_merged" {
  export GH_FAIL_STATE=merged
  run_pc "$JOB_LOOP"
  [ "$status" -eq 75 ]; [[ "$output" == *"reason=PRECHECK_UNSURE_merged"* ]]
}

@test "malformed list row fails closed: PRECHECK_UNSURE" {
  export GH_GARBAGE=1
  run_pc "$JOB_LOOP"
  [ "$status" -eq 75 ]; [[ "$output" == *"reason=PRECHECK_UNSURE_merged"* ]]
}

@test "gh view failure on FIXUP target fails closed" {
  export GH_FAIL_VIEW=1
  run_pc 'RQ-FIXUP-T1 (P1, pool=devin, repo=phantom) FIXUP phantom #1322'
  [ "$status" -eq 75 ]; [[ "$output" == *"reason=PRECHECK_UNSURE_pr_1322"* ]]
}

@test "FIXUP target PR open-dirty falls through dup gate (pr set): GO" {
  export GH_JSON_VIEW='{"state":"OPEN","mergeStateStatus":"DIRTY","statusCheckRollup":[{"conclusion":"FAILURE"}]}'
  export GH_JSON_OPEN='[{"number":1322,"title":"x RQ-FIXUP-T1","body":"","headRefName":"codex-bridge/RQ-FIXUP-T1"}]'
  run_pc 'RQ-FIXUP-T1 (P1, pool=devin, repo=phantom) FIXUP phantom #1322'
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "FIXUP target already merged still skips 10" {
  export GH_JSON_VIEW='{"state":"MERGED","mergeStateStatus":"UNKNOWN","statusCheckRollup":[]}'
  run_pc 'RQ-FIXUP-T1 (P1, pool=devin, repo=phantom) FIXUP phantom #1322'
  [ "$status" -eq 10 ]; [[ "$output" == *"reason=pr_1322_MERGED"* ]]
}

@test "missing identifiers are permanently rejected" {
  run_pc 'some line without identifiers'
  [ "$status" -eq 64 ]; [[ "$output" == *"reason=invalid_job"* ]]
}

@test "empty candidate lists: GO" {
  run_pc "$JOB_LOOP"
  [ "$status" -eq 0 ]; [[ "$output" == "GO RQ-LOOP-1" ]]
}

@test "invalid job is rejected and unavailable clone is retryable" {
  run bash "$PRECHECK" '' "$TMPD/clone"
  [ "$status" -eq 64 ]
  run bash "$PRECHECK" "$JOB_LOOP" "$TMPD/nope"
  [ "$status" -eq 75 ]
}

@test "existing source, tests and symbol never establish acceptance" {
  git -C "$TMPD/clone" init -q
  printf 'export function existingSymbol() {}\n' > "$TMPD/clone/example.ts"
  touch "$TMPD/clone/example.test.ts"
  git -C "$TMPD/clone" add .
  git -C "$TMPD/clone" -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=/dev/null commit -qm fixture
  git -C "$TMPD/clone" update-ref refs/remotes/origin/main HEAD
  git -C "$TMPD/clone" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
  run_pc "$JOB_LOOP Fix example.ts and example.test.ts. Acceptance: changed behavior"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
  run_pc "$JOB_LOOP Fix \`existingSymbol\`. Acceptance: changed behavior"
  [ "$status" -eq 0 ]; [[ "$output" == GO* ]]
}

@test "transient lookup failure recovers on the same job" {
  export GH_FAIL_STATE=merged
  run_pc "$JOB_LOOP"
  [ "$status" -eq 75 ]
  unset GH_FAIL_STATE
  run_pc "$JOB_LOOP"
  [ "$status" -eq 0 ]
}
