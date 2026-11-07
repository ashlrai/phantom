# DIAGNOSIS: Why 23 Proposals Are Stuck Pending (Never Drain)

Current routing guidance (2026-10-26): use `claude-sonnet-5-5` for new
Sonnet work and `claude-haiku-5-5` for fast, inexpensive tasks. Sonnet 4.5
retires on **November 30, 2026**. The old model identifiers below describe
historical observations and grants, not recommended routing configuration.
See Anthropic's [retirement schedule](https://platform.claude.com/docs/en/about-claude/model-deprecations)
and [Haiku 5.5 specifications](https://platform.claude.com/docs/en/models/haiku-5-5/overview).

The router catalog preserves old aliases for exact telemetry lookup. The Haiku 5.5
entry uses a conservative $0.50/$2.50 per million input/output token estimate
(prompts up to 100k tokens cost $0.10/$0.50). Catalog metadata does not
authorize account use or spending.

**Date:** 2026-06-29  
**Branch:** feat/v4-foundry  
**Status:** Read-only diagnosis. No code changed.

> **Historical snapshot — values below are stale.** This diagnosis is a
> dated point-in-time read of the config at the time (`judgePerPass: 5`).
> M259 (drain-backlog work, see `docs/MILESTONE-INDEX.md` §2) raised the
> code default to **8** (`src/core/types.ts:1075`, `src/core/fleet/automerge-pass.ts:762-766`
> — "default 8 (raised from 5 to drain backlog faster — M259)"). Fix 6 below
> was subsequently acted on; do not treat `judgePerPass: 5` as the current
> default anywhere else in the docs.

---

## Summary: Four Compounding Blockers

The queue does not drain because every single one of the 23 pending proposals
is blocked at one or more hard gates, and there is no auto-reject/archive path
that would clear them. The daemon tick DOES call `runAutoMergePass` on every
tick — that is not the problem. The blockers are structural.

---

## Blocker 1 (19 of 23): `mid`-tier proposals can never reach main

**Proposals affected:** all 19 `local-coder` runs (qwen3-coder:30b + qwen2.5:72b).

The pre-filter in `automerge-pass.ts:173-176` is:

```ts
if (!isVerificationMode) {
  const midEligible = cfg.foundry?.autoMerge?.midToBranch === true && p.engineTier === 'mid';
  if (p.engineTier !== 'frontier' && !midEligible) continue; // ← 19 proposals hit this
}
```

The config has `trustBasis: "verification"` set, which means `isVerificationMode`
is `true` — so the tier pre-filter is **skipped** and all 19 mid proposals DO
fall through to the judge-then-merge section. However they then hit Blocker 2.

In verification mode the judge must issue a `ship` verdict with a valid
frontier (claude-*) HMAC attestation before `autoMergeProposal` is called.
None of the 19 mid proposals have ANY judged entry in the decisions ledger
(confirmed by scanning all four `.jsonl` files). So they hit the judge path
every tick, consume 5 of the 5 per-pass judge slots (capped at
`cfg.foundry.judgePerPass = 5`), and the judge call fails silently (Blocker 3).

Even if they somehow received a `ship` verdict, `evaluateVerificationGate`
in `merge.ts:583+` requires `proposal.verifyResult.passed === true`. None of
the 19 carry `verifyResult` — they would fail Criterion 2 regardless.

**Bottom line for mid proposals:** Stuck permanently unless (a) the judge
can be reached AND returns `ship`, AND (b) `verifyResult.passed` is added to
each proposal. Neither condition is currently reachable.

---

## Blocker 2 (all 23): The judge is called but `managerJudgeModel: "claude-opus-4-8"` resolves to the Claude CLI, which **does reach** the judge — but returns non-`ship` verdicts

`resolveFrontierJudgeClient` in `manager.ts:587-597`:

1. Reads `cfg.foundry.managerJudgeModel` → `"claude-opus-4-8"`.
2. Checks `judgeModel.startsWith('claude')` → **true** → takes the Claude CLI path.
3. Claude CLI is installed (`/Applications/cmux.app/Contents/Resources/bin/claude`).
4. `allowedBackends` includes `"claude"` → `claudeAllowed = true`.
5. Result: the judge **is reachable** and runs as `claude-opus-4-8`.

The decisions ledger shows the judge HAS run historically (dozens of entries
from `claude-sonnet-4-5` and earlier from `phi4-mini`/`qwen2.5:72b`), but
**zero verdicts of `"ship"`** — only `"review"`, `"harmful"`, and `"noise"`.
No judged entries at all exist for any of the current 23 pending proposals
(the ledger entries are for older, now-rejected/merged/expired proposals).

The 5-per-pass cap (`judgePerPass: 5`) means at most 5 proposals are judged
per tick. With 23 pending and none accumulating ship verdicts, the queue
grows faster than it can be processed, and nothing ever advances.

**Why are verdicts not `ship`?** Three reasons observable from the diffs:

- **2 `claude:default` proposals** (`prop-mqzxb7q4`, `prop-mqzwvnlq`): their
  diff is **identical** — both produce only `.mcp.json` with the same content
  (diffHash `6dabde60...`). One is `isPartial: true` (engine exited 1). The
  judge correctly identifies these as noise/harmful: they add an MCP server
  config to the repo root which is a security-sensitive change.

- **19 mid proposals**: their diffs are documentation files or CI fixes — the
  judge is likely returning `review` because they lack test coverage, are
  duplicates, or contain low-signal content.

- **2 `codex:default` proposals**: would receive verdicts but are also blocked
  by Blocker 3 (`:default` suffix, see below).

---

## Blocker 3 (4 frontier proposals): `engineModel` ends in `:default` → merge authority refused unconditionally

All 4 frontier proposals have `engineModel: "claude:default"` or
`engineModel: "codex:default"`.

`evaluateMergeAuthority` in `merge.ts:404-451`:

```ts
if (engineModel.endsWith(':default')) {
  return {
    authorized: false,
    reason: `engineModel '${engineModel}' has no concrete model pinned (':default') — merge authority requires a vetted model`,
  };
}
```

Even if the judge ships them, `autoMergeProposal` will reject them at Gate 4
because no concrete model is pinned. The `mergeAuthority` config requires
`codex:gpt-5.5` and `claude:claude-sonnet-4-5` — not `:default` aliases.

Additionally, in `verification` mode the gate also requires:
- `verifyResult.passed === true` — absent on all 4 frontier proposals.
- A valid HMAC-signed frontier judge attestation in the ledger — none exist
  for any of the 23 current proposals.

---

## Blocker 4 (no proposals): No auto-reject / cleanup path

When a proposal fails the judge (verdict `review`, `noise`, or `harmful`),
`automerge-pass.ts:208-219` does:

```ts
if (!verdict || verdict.verdict !== 'ship') {
  learnFromRejection(...);
  continue; // ← proposal stays 'pending'
}
```

The proposal's status is **never updated to `rejected`**. It stays `pending`
forever and is re-evaluated on every subsequent tick. This means:

1. The same proposals are sent to the judge repeatedly, burning judge budget.
2. The queue never shrinks — old proposals pile up indefinitely.
3. The 5-per-pass cap is consumed entirely by the oldest pending proposals,
   leaving new (potentially valid) proposals unprocessed.

There is no TTL, no duplicate-detection reject path, and no "N failed judge
attempts → archive" rule anywhere in the codebase.

---

## Proposal-by-Proposal Breakdown

### Genuinely mergeable (0 of 23)

None of the 23 are currently auto-mergeable. Summary of why:

| # | Proposals | Blocker |
|---|-----------|---------|
| 2 | `claude:default` (mqzxb7q4, mqzwvnlq) | `:default` model → no merge authority; identical `.mcp.json` diff; `isPartial` on one; no `verifyResult` |
| 2 | `codex:default` (mqsg1rx6, mqrh387s) | `:default` model → no merge authority; no `verifyResult`; no ship verdict |
| 19 | `local-coder` mid-tier | No ship verdict from frontier judge; no `verifyResult`; duplicate diffs on #38 fix (10+ identical proposals) |

### Closest to mergeable

**`prop-mqrh387s-000000-821b`** (`codex:default`, `docs/FLEET_PROOF.md`):
- Tiny diff (1-line doc file + small test additions; 73 diff lines)
- Low risk, in-scope, not security-sensitive
- Would be mergeable IF: (a) re-run with `codex:gpt-5.5` so model is pinned,
  (b) `verifyResult` is set (tests pass), (c) judge ships it.

**`prop-mqsg1rx6-000000-a023`** (`codex:default`, Windows support for phantom-secrets):
- Actual feature work (Rust changes to `reveal.rs`)
- Blocked by `:default` + no `verifyResult` + no ship verdict
- Needs manual review regardless (Windows path logic, Rust changes)

---

## Root Cause (Single Sentence)

The queue never drains because: (1) all 23 proposals lack a frontier judge
`ship` verdict with HMAC attestation (verification mode requires this); (2) the
4 frontier proposals additionally have `:default` model aliases that
`evaluateMergeAuthority` hard-rejects; (3) after a non-ship verdict, proposals
stay `pending` forever with no cleanup — so the 5-per-pass judge cap is
permanently consumed by the oldest stale proposals, starving newer ones.

---

## Fix Plan (no code changes yet — plan only)

### Fix 1 (highest impact): Auto-archive non-ship proposals after K judge attempts

In `automerge-pass.ts`, when `verdict.verdict !== 'ship'`, add a judge-attempt
counter to the proposal record. After K attempts (suggest K=3), flip status
to `rejected` with reason `"auto-archived: judge returned non-ship ${K} times"`.

This immediately unblocks the cap, shrinks the queue, and prevents re-judging
stale proposals indefinitely.

```ts
// automerge-pass.ts — after the non-ship continue
if (!verdict || verdict.verdict !== 'ship') {
  learnFromRejection(...);
  const attempts = (p.judgeAttempts ?? 0) + 1;
  if (attempts >= MAX_JUDGE_ATTEMPTS) {
    setProposalStatus(p.id, 'rejected', `auto-archived after ${attempts} non-ship verdicts`);
  } else {
    updateProposalJudgeAttempts(p.id, attempts);
  }
  continue;
}
```

### Fix 2: Add a TTL / staleness reject for proposals older than N days

Proposals older than 7 days with no ship verdict should auto-reject. This
covers the 10+ duplicate `Fix issue #38` proposals from weeks ago.

### Fix 3: De-duplicate identical-diff proposals at submission time

The 10 `Fix issue #38` proposals all have effectively the same content.
`listProposals` at submission time should check diffHash deduplication and
reject/skip duplicates immediately rather than letting them accumulate.

### Fix 4: Require concrete model at engine dispatch time

Prevent `:default` proposals from reaching the inbox. The engine dispatch in
`loop.ts` should pin the resolved model before writing the proposal record.
`engineModel` should be the concrete resolved model string, not `:default`.

### Fix 5: Add `verifyResult` to proposals before they reach the merge pass

For `verification` mode, `autoMergeProposal` requires `verifyResult.passed === true`
(Criterion 2). The engine run pipeline should run tests and attach `verifyResult`
before writing the proposal, not leave it absent.

### Fix 6: Raise `judgePerPass` or add a separate cleanup pass for stale/duplicate proposals

Current `judgePerPass: 5` means ~5 proposals judged per tick. With 23 pending
(none of which will ship), every tick wastes 5 judge calls. Either:
- Raise `judgePerPass` to 10-15 temporarily while the backlog clears, OR
- Add a pre-pass that auto-rejects obvious non-shippable proposals (`:default`
  model, `isPartial: true`, duplicate diffHash, no diff) before the judge loop.

### Execution order

1. Fix 1 (auto-archive after K non-ship verdicts) — clears the current 23 immediately
2. Fix 4 (concrete model at dispatch) — prevents future `:default` accumulation  
3. Fix 3 (diffHash dedup at submission) — prevents duplicate floods  
4. Fix 2 (TTL/staleness) — belt-and-suspenders cleanup  
5. Fix 5 (`verifyResult` attachment) — enables verification-mode merges to actually complete  
6. Fix 6 (judgePerPass tuning) — optimization after 1-4 land

---

## Config Observations

Current `~/.ashlr/config.json` highlights relevant to this diagnosis:

```json
"autoMerge": {
  "enabled": true,           // ✓ pass is active
  "trustBasis": "verification", // ← requires frontier judge ship + HMAC + verifyResult
  "maxRisk": "low",
  "maxAutomergeFiles": 4,
  "maxAutomergeLines": 150
},
"mergeAuthority": [
  {"engine":"codex", "model":"gpt-5.5"},
  {"engine":"claude", "model":"claude-sonnet-4-5"}
],
"managerJudgeModel": "claude-opus-4-8", // ✓ judge is reachable (Claude CLI installed)
"judgePerPass": 5                        // ← capped at 5/tick; too low for 23-proposal backlog
```

`models.providerChain: ["ollama"]` — this does NOT prevent the judge from
running. `resolveFrontierJudgeClient` checks `allowedBackends` and
`engineInstalled('claude')`, not `providerChain`. The Claude CLI is installed
and `claude` is in `allowedBackends`, so the judge runs via Claude CLI
subprocess regardless of the ollama-only provider chain for engine runs.

## Captured merge throughput diagnostic

Run `npm run dev -- fleet merge-throughput --input snapshot.json --json`
(or `telemetry merge-throughput`) to diagnose a captured window without config,
credentials, network access or mutations. This does not collect GitHub evidence.
The collector must supply exhaustive merge history for the stated window and
backlog states as of its end, using one unique repository-qualified PR ID per row.
Do not treat a truncated API page or a failed collection as complete.

```json
{
  "start": "2026-10-28T10:00:00Z",
  "end": "2026-10-28T12:00:00Z",
  "complete": true,
  "observations": [
    {"id": "ashlrai/phantom#1", "state": "merged", "mergedAt": "2026-10-28T11:00:00Z"},
    {"id": "ashlrai/phantom#2", "state": "waiting"}
  ]
}
```

This reports one completed merge, one waiting observation, and 0.5 merges/hour.
The UTC window is start-inclusive and end-exclusive. Waiting work is an observed
end-of-window stock, not a rate or a completed merge. Merged rows outside the
window are excluded. `complete: false` or any `state: "unknown"` row makes
`completedMerges` and `mergesPerHour` null (text: `unknown`), while observed
counts remain available as lower bounds. Empty incomplete observations are
unknown; only explicitly complete empty coverage establishes zero throughput.
Unknown row counts do not quantify unobserved work. Coverage is collector-supplied,
not independently verified. Input is limited to 1 MiB and 20,000 rows; duplicate
IDs, invalid timestamps/states and nonpositive windows fail closed. Errors never
echo captured contents. Exit codes: 0 report, 1 invalid/unreadable input,
2 invalid command arguments.

Executable regression tests are kept here to respect this job's named-file scope.
Run with a temporary HOME:
`HOME=$(mktemp -d) node --import tsx --input-type=module -e 'import {readFileSync} from "node:fs"; const doc=readFileSync("docs/DIAGNOSIS-MERGE-DRAIN.md","utf8"); await import("data:text/javascript,"+encodeURIComponent(doc.slice(doc.lastIndexOf("<!-- merge-throughput-tests -->")).split("```js")[1].split("```")[0]));'`

<!-- merge-throughput-tests -->
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { diagnoseMergeThroughput: diagnose, cmdMergeThroughput } =
  await import(pathToFileURL(`${process.cwd()}/src/cli/telemetry.ts`).href);
const base = { start: '2026-10-28T10:00:00Z', end: '2026-10-28T12:00:00Z', complete: true, observations: [] };
test('empty evidence requires explicit completeness for zero', () => {
  assert.equal(diagnose(base).mergesPerHour, 0);
  assert.equal(diagnose({ ...base, complete: false }).mergesPerHour, null);
  assert.throws(() => diagnose({ ...base, complete: undefined }));
});
test('partial and unknown observations never produce zero throughput', () => {
  for (const complete of [true, false]) {
    const report = diagnose({ ...base, complete, observations: [{ id: '1', state: 'unknown' }, { id: '2', state: 'waiting' }] });
    assert.equal(report.completedMerges, null);
    assert.equal(report.mergesPerHour, null);
    assert.equal(report.waitingObservedAtEnd, 1);
    assert.equal(report.unknownObservations, 1);
  }
});
test('populated evidence uses merge timestamps and separates backlog', () => {
  const observations = [
    { id: '1', state: 'merged', mergedAt: base.start },
    { id: '2', state: 'merged', mergedAt: '2026-10-28T11:00:00Z' },
    { id: '3', state: 'merged', mergedAt: base.end },
    { id: '4', state: 'waiting' },
  ];
  assert.equal(diagnose({ ...base, observations }).mergesPerHour, 1);
  const partial = diagnose({ ...base, observations, complete: false });
  assert.equal(partial.completedMergesObserved, 2);
  assert.equal(partial.mergesPerHour, null);
});
test('malformed observations and windows fail closed', () => {
  for (const change of [
    { end: base.start }, { start: '2026-02-30T10:00:00Z' },
    { observations: [{ id: '1', state: 'merged' }] },
    { observations: [{ id: '1', state: 'done' }] },
    { observations: [{ id: '1', state: 'waiting' }, { id: '1', state: 'unknown' }] },
  ]) assert.throws(() => diagnose({ ...base, ...change }));
});
test('both CLI aliases render unknown and populated evidence', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const path = join(mkdtempSync(join(tmpdir(), 'merge-throughput-')), 'snapshot.json');
  for (const command of ['fleet', 'telemetry']) {
    for (const complete of [false, true]) {
      writeFileSync(path, JSON.stringify({ ...base, complete }));
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', command,
        'merge-throughput', '--input', path, '--json'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).mergesPerHour, complete ? 0 : null);
    }
  }
});
test('CLI rejects missing and unknown arguments', async () => {
  assert.equal(await cmdMergeThroughput([]), 2);
  assert.equal(await cmdMergeThroughput(['--typo']), 2);
});
```
