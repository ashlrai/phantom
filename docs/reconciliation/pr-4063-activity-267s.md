# Reconciliation: PR #4063 (RQ-SWE3-ATTEMPT-RACE-1) — fleet agent activity attempt race

Internal reconciliation record for the accumulated-original-PR backlog
(Mason Nov 5 21:46 order; Nov 12 22:29 truthful fleet-state order). This is
backlog reconciliation, not new feature work.

- Original PR: ashlrai/phantom#4063, head `5d520f739f0127fc434c4b1fb0bd60f5b26acdfd`
  (verified via `git fetch origin pull/4063/head`).
- Original commit under comparison: `5d520f739f` — the PR's own seven-path
  commit (the branch shares no merge base with current master; only this
  commit's paths were compared, never the accumulated branch diff).
- Current source: `origin/master` = `b9e4b9dfc8b5d9bf23edc82d3de6cffe208bbb20`
  (worktree HEAD at reconciliation time).
- New executable evidence: `test/fleet-activity-original-cli-replay-267s.test.ts`
  replays a temporary `jobs.jsonl` ledger through the real exported
  `cmdFleetActivity` (`--json --jobs`), proving stale pre-boundary
  finish/publish/outcome rows cannot advance a requeued job's newest attempt
  and that reads never mutate the ledger.

## What the original commit intended

`fleet.agent-activity.v1`: a read-only projection of per-job
launch→finish→publish→outcome lifecycle folded from the host metrics ledger
(`metrics/jobs.jsonl`), exposed as `phm fleet activity`,
`GET /api/fleet/activity`, and the `activity` fleet subcommand. Its core
race fix: a repeated job id starts a fresh attempt at the next queue/launch
after a terminal event; the newest queue/launch time is the attempt
boundary, and finish/publish/outcome rows stamped before it belong to the
older attempt and never advance the requeued job.

## Preservation matrix

| Original path (commit `5d520f739f`) | Intended behavior | Current location (master `b9e4b9dfc8`) | Status |
|---|---|---|---|
| `src/core/fleet/agent-activity.ts` (new, 400 lines, blob `aa345f43`) | Lifecycle fold, attempt-boundary race guard, bounded tail read, `agentActivityLines`, `readAgentActivity`, `summarizeAgentActivity` | Same path, 835 lines, blob `d591e658`. Original logic preserved: `Attempt`/`boundary`/`reset`/`lastBoundary`, stage derivation, guards on finish/publish/outcome all present. Refactors only: ledger tail read extracted to `readLedgerTail`, `inferredEvent` added for eventless producer rows, `published`→`publish` normalization. Superset: `fleet.verified-completion.v1` (`VerifiedCompletionReport`, `foldVerifiedCompletion`, `readVerifiedCompletion`, `summarizeVerifiedCompletion`) added later. | **Preserved** (superset) |
| `src/cli/fleet-activity.ts` (new, 52 lines, blob `5cb73fa0`) | `cmdFleetActivity` CLI: `--json`, `--hours`, `--limit`, `--jobs`; human line projection | Identical blob `5cb73fa0` — byte-for-byte preserved. | **Preserved** |
| `src/cli/fleet-subcommand-registry.ts` (+1 line) | Register `activity` loader | `'activity': () => import('./fleet-activity.js')` still present (line 5); file grew to 409 lines with other subcommands. | **Preserved** |
| `src/core/web/api.ts` (+17 lines) | `GET /api/fleet/activity` route → `readAgentActivity` with bounded `hours`/`limit` | Route present at `src/core/web/api.ts:2035` with same bounded-params call; current file also serves `GET /api/fleet/verified-completion`. | **Preserved** (superset) |
| `docs/FLEET-API.md` (+1 line) | Document `GET /api/fleet/activity` | Row present (line 46); current adds the verified-completion row (line 47). | **Preserved** (superset) |
| `docs/FLEET-VERBS.md` (+1 line) | Document `fleet activity` verb incl. attempt-boundary semantics | Row present (line 8) with the same boundary description, extended to mention `verified`. | **Preserved** (superset) |
| `test/fleet-activity.test.ts` (new, 294 lines, blob `d1041898`) | Unit coverage: full lifecycle fold, running/finished/queued stages, re-launch attempt reset, stale straggler finish/publish/outcome rejection, malformed lines, window/limit, output-boundary revalidation, CLI smoke + registry | All original cases present in current 303-line file (blob `0cbaa524`); additions are verified-completion fixtures in the `agentActivityLines` boundary test. The attempt-race cases (`treats a launch after terminal events as a new attempt`, `does not let a stale outcome close a re-launched job`, delayed outcome/finish/publish stragglers) are unchanged. | **Preserved** (superset) |

## New evidence added by this reconciliation

`test/fleet-activity-original-cli-replay-267s.test.ts` is the independent
CLI replay the original PR lacked: it drives the real `cmdFleetActivity`
with `--json --jobs <tmp ledger>` and the CLI's own `now` parameter (no
reader/fold mocks, no env mutation, console spy restored), and asserts:

1. After a completed old attempt plus appended requeue/new launch, the
   report stage is `running` with the new `launchedAt`.
2. After delayed finish/publish/outcome rows stamped before the new
   boundary are appended, a fresh CLI read still reports `running` —
   `finishedAt`/`publishedAt`/`outcomeAt`/`outcome`/`url` all null.
3. A finish-only second job reports stage `finished` and is counted by the
   current report contract as `completedUnpublished`, not a verified claim
   (`verified.eligible === 1`, `verified.verified === 1`) — a successful
   finish alone is not independently verified completion.
4. After real current-attempt finish/publish/outcome rows are appended, a
   fresh read reports `merged` with all boundary stamps.
5. Ledger bytes are identical before and after every CLI read (read-only
   proof).

No production-code change was required: the replay passes against current
master, so `src/core/fleet/agent-activity.ts` is untouched and all newer
verified-completion and eventless-row semantics are preserved.

## Scope note

The fresh local ledger evidence here is a synthetic replay through the CLI
fold — it is not live-host ownership evidence and not Slack/dispatch
evidence. It proves the projection contract only; it does not claim any
running fleet state, does not close or merge anything, and publishes no
private data, logs, or inbox excerpts.
