# RQ-DRAIN-PHX-REB-31 disposition notes

Job: RQ-DRAIN-PHX-REB-31, pool zai, repo ashlrai/phantom. Dispatched 2026-11-25 22:02:32Z ET
with six dirty backlog PRs. All facts below verified against saved API responses
(`api/*.json`) and local git reads against a pinned master snapshot.

## Probe result: all six closed before dispatch

All six supplied head SHAs match the GitHub API exactly. All six PRs are **closed unmerged**
(`merged: false`, `auto_merge: null`, `mergeable_state: dirty`). They were closed in one batch
by owner `masonwyatt23` on 2026-11-24T22:35:36Z-49Z, roughly 23.5 hours before the dispatch
roster snapshot, each with the identical comment:

> Closing as stale: this automated bridge PR has conflicted with master since 2026-11-15 and
> the fleet has moved past it. If the change is still wanted, re-cut the job from current
> master or reopen this PR. (Backlog drain by Devin, standing autonomy.)

| PR | branch | head SHA (supplied = API) | closed_at |
| --- | --- | --- | --- |
| 5897 | codex-bridge/RQ-REBASE-PHANTOM-4742 | 8abebe7868938ca9151ae94b88ebb81cbd5c61f8 | 2026-11-24T22:35:49Z |
| 5894 | codex-bridge/RQ-REBASE-PHANTOM-4653 | 84cb3a1698d4c703308ad7b0542a0f8d498b7cb7 | 2026-11-24T22:35:46Z |
| 5885 | codex-bridge/RQ-REBASE-PHANTOM-4543 | 725d3b712c13665f85687201ce269a30fab018ec | 2026-11-24T22:35:44Z |
| 5875 | codex-bridge/RQ-REBASE-PHANTOM-4261 | 785bda519657dd224150b38fb4b9fa5780a4fc0d | 2026-11-24T22:35:41Z |
| 5870 | codex-bridge/RQ-REBASE-PHANTOM-4136 | bdfeea1df026efa5092498f71aa46119afba04b8 | 2026-11-24T22:35:39Z |
| 5869 | codex-bridge/RQ-REBASE-PHANTOM-4169 | 634536080548239a2bc951fd48e272a762be8043 | 2026-11-24T22:35:36Z |

Prior comments of record: 5894 and 5870 carry a 2026-11-18 owner handoff
("rebuild needed, not superseded"); 5885 carries a 2026-11-18 owner hold comment about
out-of-band pushes to its branch (its API-cached stats, 12 files +1333/-1151, reflect that
older branch state; the current head's own commit changes 2 files).

Per the task's step 1 (skip if not open), all six were skipped: no rework, no merge,
no push, no closure, no comment. No write path exists from this lane anyway (origin push
URL is no_push, GitHub CLI is blocked by the host privacy controls, the operator publisher
is operator-only, and the job rules forbid commits/pushes/publishing).

## Why they can never merge as-is: pre-recut lineage

Current master was re-rooted. Pinned master `f4d32986e72f724dbe755b39076739de2175cecc`
has a single root commit `30da2cce8c`; all six PR heads descend from the pre-recut root
`814f3c385d`. `git merge-base` (retried against a pinned SHA to defeat the known shared
object-store race) returns nothing for any of the six: no common ancestor with master.
A "merge current origin/master INTO the PR branch" would require unrelated-history
reconciliation and GitHub reports them dirty. The owner's closure guidance (re-cut from
current master) is the only viable path, which matches the fleet's recut pattern.

## Supersession / unique-work ledger (vs pinned master)

Method (mirrors the RQ-DRAIN-PHX-REB-33 evidence kit): each PR is a single commit on its
old-line parent, so the PR's own change is `git diff prhead^ prhead`. Per file: blob compare
against master (`pr-N-blobs.tsv`), and hunk-level presence of the PR's added lines in
master's current version of the same path, meaningful lines being at least 8 chars
(`pr-N-hunk-presence.txt`). Landing commits per path are in `landing-commits.txt`.

| PR | files | SAME on master | DIFFERS | PR_ONLY (absent) | added lines present | deleted lines still on master |
| --- | --- | --- | --- | --- | --- | --- |
| 5897 | 19 | 2 | 15 | 0 (+2 job-local scratch) | 216/301 | 1/73 |
| 5894 | 65 | 29 | 32 | 4 | 1952/2767 | 167/613 |
| 5885 | 2 | 1 | 1 | 0 | 7/10 | 0/0 |
| 5875 | 18 | 2 | 13 | 3 | 189/455 | 0/6 |
| 5870 | 161 | 50 | 66 | 45 | 3668/13803 | 5111/5556 |
| 5869 | 18 | 1 | 16 | 1 | 820/1110 | 3/9 |

### 5897 (RQ-REBASE-PHANTOM-4742): mostly landed
- Landed byte-identical: `src/core/intent/native-stale.ts`,
  `test/intent-native-stale-preservation-232s.test.ts` (via RQ-PHX-RECUTCOREOLDC344, #5572,
  2026-11-14). `src/core/mcp-native.ts` and `docs/CODEMAP.md` added hunks fully present.
- Unlanded unique slice: the `wb locus|secrets --help/-h` usage-and-exit-0 behavior
  (4 lines in `src/cli/wb.ts` plus its test in `test/wb-secrets-cli.test.ts`; master's
  versions lack it). Residual CHANGELOG/docs lines.

### 5894 (RQ-REBASE-PHANTOM-4653): substantially landed
- Landed: work-result slice (#5550), fleet-recheck slice (#5482), channel-health slice
  (#5441) and 29 byte-identical files including most 33x/340-series tests.
- Unlanded unique: the CLI-registry sort tooling, `scripts/lib/cli-registry-sort.mjs`,
  `scripts/sort-cli-registries.mjs`, `test/cli-registry-merge-friendly.test.ts` (absent from
  master at any path; the only master references are other jobs' saved PR-list JSON
  snapshots), `test/config/realio-lane-membership.mjs`, and partial hunks
  (`src/cli/completions.ts` 71/103 added present and 124 deleted lines remain,
  `src/core/agents/slack-request-trace.ts` 76/116, `src/core/fleet/fleet-recheck.ts`
  310/338, `test/slack-reply-receipt-replay-337s.test.ts` 21/42,
  `src/core/fleet/channel-health.ts` 77/99). `tmp_fleet-recheck.ts` is scratch.

### 5885 (RQ-REBASE-PHANTOM-4543): essentially landed
- Landed byte-identical: `test/m2.doctor-exit-code.test.ts` (predates the PR; M2-era
  3a528264af).
- Unlanded residue: 3 of its 8 `test/fixtures/authority/tier1-closure.json` entries
  (the ui-settings trio) are absent from master's rebuilt fixture (1672 lines) although
  those ui-settings source files exist on master. Authority baseline: any recovery is an
  owner/authority-aware decision, not a bridge edit.

### 5875 (RQ-REBASE-PHANTOM-4261): custody slice landed, fleet-heavy unlanded
- Landed: `src/core/receipt/receipt-dispatch.ts` and `src/core/run/custody-capture.ts`
  byte-identical (custody-capture via #3926); `src/core/daemon/loop.ts`,
  `src/core/run/engines.ts`, `.github/CODEOWNERS`, fixture additions fully present;
  `test/custody-wrap-receipt.test.ts` 100/106.
- Unlanded unique: the fleet-heavy runner, `contrib/mac/fleet-heavy`,
  `contrib/mac/tests/test_fleet_heavy.py`, `scripts/fleet-heavy.mjs` (absent from master;
  the only master hits for the name are unrelated host-load prose), plus the CI-script
  changes (`scripts/test-ci.mjs`, `scripts/typecheck-fast.mjs`, `scripts/verify-changed.mjs`,
  `test/m372.test-ci-watchdog.test.ts`, `test/verify-changed-dedupe.test.ts`,
  `test/verify-changed-tsc-cache.test.ts`) and most of `contrib/mac/dispatchd.py` (1/24).

### 5870 (RQ-REBASE-PHANTOM-4136): largest unlanded slice
- Landed: 50 byte-identical files, chiefly the work-result board slice (#5550 and siblings).
- Unlanded unique: 45 files absent from master at any path, including the whole
  `src/core/connect/*` feature (8 files), `src/core/routing/local-*` plus
  `routing-engines.ts`/`routing-ledger.ts` (6), `src/core/fleet/status-*` (12),
  `src/core/ecosystem/changelog-compact.ts`, `src/cli/connect.ts`,
  `scripts/ecosystem-changelog.ts`, `docs/GROK-BOT-BUS.md` and ~16 tests plus fixtures.
  Only 3668/13803 meaningful added lines are present on master and 5111/5556 of its deleted
  lines still exist on master, i.e. master also declined this PR's removals.

### 5869 (RQ-REBASE-PHANTOM-4169, marked HOLD in its own commit title): core landed
- Landed: the action-classes core landed in evolved form via #6380
  (feat(security): add the publish/merge action-class registry, 2026-11-16):
  `contrib/mac/action-classes.json` byte-identical, `src/core/authority/action-classes.ts`
  257/264, `contrib/mac/action_classes.py` 125/136,
  `test/authority-action-classes.test.ts` 134/141; `src/core/fleet/self-tick.ts` fully
  present (#2854); CODEOWNERS and fixture additions fully present.
- Unlanded unique: `src/cli/fleet-action-classes.ts` (the CLI verb, whole file absent),
  most of `contrib/mac/dispatchd.py` integration (5/40), `contrib/mac/install.sh` and
  `test_install.py` hunks, `contrib/mac/publish.sh` hunks (operator-owned file),
  `src/cli/completions.ts` and `src/core/vision/leader-apply.ts` hunks.

## Coverage by open PRs

A fresh open-PR snapshot (280 open PRs, 2026-11-26T03:16:21Z, `open-prs.tsv`) shows no PR
covering the unlanded slices by title. Bridge PR titles are opaque job IDs, so title
scanning is weak evidence; content search of the pinned master tree found the unlanded
feature names only inside other jobs' saved API JSON snapshots (stale PR title strings),
not in any source file. No replacement PR exists for the unlanded work listed above; the
merged landing PRs cited per slice are the replacements for what did land.

## Check status

No checks were run by this job (no code change, no new head; the job is analysis-only like
REB-33). Last known hosted state at close for all six: `mergeable_state: dirty`
(merge conflicts), per the saved API responses.
