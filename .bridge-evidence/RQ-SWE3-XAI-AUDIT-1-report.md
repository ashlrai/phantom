# RQ-SWE3-XAI-AUDIT-1 — xAI usage audit, Nov 2–7 2026

Read-only security audit. Question asked (owner, via teammate): did Phantom or
any fleet session run JobBench, its evaluation judge, or coding/research
workloads using xAI between 2026-11-02 and 2026-11-07, around the disabled
xAI "Evero" key incident? Were credentials exposed in logs?

All timestamps UTC unless noted. Host: MacBook-Pro-2.local. Audit performed
2026-11-07/08. Nothing was re-enabled, rotated, or touched; this file plus
BRIDGE_NOTES.md are the only writes.

---

## TL;DR

- **xAI ran in the window — but only the proposal *judge*, only on the
  SuperGrok *subscription* seat (`grok-cli`), never the API key.** Daily
  ~12:00Z batches of 15 judgments, engine recorded `grok-cli:grok-4.7`,
  produced real verdicts Nov 1–6. On **Nov 7 12:00Z all 15 calls failed**
  (`judge-parse-failure`, ~4 s each vs ~60 s on prior days).
- **Zero coding/research workload attempts ran on any xAI path** in the
  window: all 183 attempt/dispatch records are `local-coder:qwen3.8:27b-ctx64k`
  (all `engine-failed`). The seat router excluded grok all week — first for
  "no usage reading", then for the weekly window reading 100% spent.
- **No artifact named "JobBench" exists** in the repo, `~/.ashlr`, or
  worktrees. The `eval swe-bench` harness last produced reports 2026-07-06.
- **No credential material found in any accessible log/ledger.** Zero
  `xai-<20+ alnum>` shapes anywhere; `XAI_API_KEY`/`GROK_API_KEY` appear only
  as env-var *names* in code/docs/test fixtures.
- **The `grok` per-token API engine (the `XAI_API_KEY` → api.x.ai path the
  Evero key would feed) is not in `foundry.allowedBackends`** and the legacy
  `ashlr.yaml` `llm:` xAI block is `enabled: false` — the API-key path was
  never wired to run.
- **First-ever grok weekly-usage reading: 2026-11-06 21:39Z = 100% used**
  (window Nov 2 01:21Z → reset Nov 9 01:21Z, source `grok-native-billing`).
  Judge calls began failing ~14 h later.
- **Wider lockdown Nov 7–8**: kill switch on twice (01:26Z, 04:13Z), fleet
  merge-authority revoked both times, JEV classifier disabled Nov 6 22:29,
  continuous daemon stopped Nov 8 00:05Z ("paid work remains
  dispatch-blocked").
- **Audit gap:** `~/.ashlr-runs` (jobs.jsonl, dispatchd logs, lane homes) is
  OS-sandboxed and unreadable — the router-queue job ledger could not be
  inspected. See Limitations.

---

## Observations (direct evidence)

### 1. xAI paths in Phantom (repo source, current main)

- `src/core/run/engine-registry.ts`: two distinct xAI engines.
  - `grok` — `kind: 'api-model'`, `envKey: XAI_API_KEY` (alias
    `GROK_API_KEY`), `https://api.x.ai/v1`, default `grok-4`, tier `mid`,
    "BUILTIN but NOT in default allowedBackends".
  - `grok-cli` — `kind: 'cli-agent'`, the `grok-a` SuperGrok **seat** via
    `launcher.mjs` + per-run `GROK_HOME`, tier `frontier`.
- `~/.ashlr/config.json`: `foundry.allowedBackends =
  [builtin, local-coder, claude, codex, nim, kimi, grok-cli]` — `grok` API
  engine absent; `foundry.managerJudgeEngine = codex`,
  `managerJudgeModel = gpt-5.5`, `judgePerPass = 5`. `phantom = {}`
  (custody wrap disabled globally).
- `~/.ashlr/ashlr.yaml` `llm:` block: `enabled: false`, `provider: xai`,
  `model: grok-4-1-fast-reasoning`, `api_key_env: XAI_API_KEY`.
- `src/core/inbox/merge.ts:1838`: `grok-cli:<model>` is the *only* xAI
  spelling accepted as a frontier judge (verification mode); bare `grok-4.7`,
  `grok:`, `xai:` are refused.
- `src/core/fleet/manager.ts:1270–1460`: judge calls are confined — private
  run dir, ephemeral `GROK_HOME` copy, OS sandbox, credential overlay only
  for claude; on failure the judge completes `''` → fail-closed `review`.

### 2. What ran — workload engines (`~/.ashlr/runs`, `dispatch-production`, `fleet/quota.json`)

- `~/.ashlr/runs/attempt-*.json`, mtime Nov 2–8: **183 records, every one
  `engine=local-coder`, `engineModel=local-coder:qwen3.8:27b-ctx64k`**.
  Zero grok/grok-cli/xai engines.
- `~/.ashlr/dispatch-production/2026-11-0{2..8}.jsonl`: 183 dispatches, all
  `backend=local-coder`, `model=qwen3.8:27b-ctx64k`; all
  `outcome=engine-failed` (the local lane itself is down — separate issue).
- `~/.ashlr/fleet/quota.json` backend-assignment ledger: Nov 2–8 all
  `local-coder` (43/84/24/15/13/3/1 per day). Last `grok-cli` assignments:
  2026-10-14 (3); heavy routing earlier: Oct 6 ×39, Oct 7 ×71.
- `~/.ashlr/routing/decisions{,.1}.jsonl`: every decision in the window
  excludes seat `grok` — reasons `"No usage reading for this seat — unknown
  usage is not headroom, so autonomy stays off it"` and later `"The weekly
  window is spent — 100% used (resets 2026-11-09T01:21:22.542Z)"` +
  `"usage reading is 17 h old — too stale"`. Winning seats: `local-coder`
  for work, `devin-cli` for leader tasks.

### 3. The evaluation judge DID use xAI (`judge-traces`, `decisions`)

- `~/.ashlr/judge-traces/2026-*.jsonl`: `judgeEngine: "grok-cli:grok-4.7"`
  every day Oct 13 → Nov 6, ~11:00–12:15Z, 2–15 records/day on `prop-mv*`
  proposals (a recurring set, re-judged daily). Nov 2–6: 15/day, verdict mix
  `review`/`noise`, ~60 s/call — real model output (`noise` requires a
  parsed verdict, not a fallback).
- `~/.ashlr/decisions/2026-*.jsonl` — `action:"judged"` entries with
  `engine`/`model` `grok-cli:grok-4.7`, `judgeReasonCode`:

  | date (UTC) | judgments | span | avg/call | codes |
  |---|---|---|---|---|
  | Nov 1–6 | 15/day | ~13–16 min | ~58–68 s | `judge-review`, `judge-noise` |
  | **Nov 7** | **15** | **60 s** | **4.3 s** | **`judge-parse-failure` ×15** |

- `~/.ashlr/custody/spawns.jsonl` (rotated ledger, earliest entry Nov 7
  06:43Z): **30 grok spawn attempts 2026-11-07 12:00:02–12:01:05Z** —
  2 per proposal (initial + one-shot reprompt retry), all
  `wrapped:false, reason:"phantom-disabled"`. `phantom-disabled` = the
  `phantom exec` secrets wrapper is disabled (`cfg.phantom.enabled` unset);
  it is the fleet-wide default, also on `devin` spawns — **not** a grok
  kill switch. The spawns ran unwrapped; their output was unparseable →
  synthetic `review` fallbacks (`judgeFailure:'parse'` semantics in
  manager.ts:101–106).
- Judged content: 15 `prop-mv*` proposals produced by `local-coder` runs
  under outcome `outcome-6019dec1-…` (mission per
  `~/.ashlr/goals/outcome-f4c4bd1e-….json`: *"Verify the grok engine can
  produce a non-empty diff and pass a vitest on fleet-canary"*, created
  Oct 21, owner mason@evero-consulting.com, archived, updated Nov 7 11:32Z).
- No `judge-traces/2026-11-07.jsonl` exists although decisions were logged —
  the trace writer produced nothing for the failed batch.

### 4. Seat credential state (`native-profiles/grok-a`)

- Seat = grok CLI **1.0.46** at `~/.grok/downloads/grok-1.0.46-macos-aarch64`,
  launched via `launcher.mjs` (node 24) — `profile.json`.
- `native-state/auth.json` exists, mode 0600, last written **Oct 10 19:49**
  (contents never read — existence/mtime only).
- `native-state/logs/unified.jsonl` (ends Oct 10 19:59): auth method
  `cached_token`, `has_external_api_key: false`, weekly
  `USAGE_PERIOD_TYPE_WEEKLY` billing — i.e. subscription OAuth, **not** an
  API key. Judge runs' per-run `GROK_HOME` copies are ephemeral, so seat-run
  logs after Oct 10 are absent by design.

### 5. Quota / capacity (`routing/capacity*.json*`)

- `routing/capacity.json` grok seat (observed Nov 7 07:23Z):
  `grok_unified_weekly usedPercent=100`, period Nov 2 01:21Z → reset
  Nov 9 01:21Z, `costBasis: subscription`, `reachable: null`,
  `limitReached: false`, `accountHint` (sha256 fingerprint, value-free).
- `routing/capacity-history.jsonl`: **first** grok readings ever recorded
  are Nov 6 21:39Z onward — all `usedPct=100`, source `verse`. No earlier
  readings at all (matches "no usage reading" exclusions).

### 6. Incident-adjacent events (`~/.ashlr/audit`)

- Nov 7 01:26Z `kill:on` + `fleet:host-merge-revoke` ("revoked 0 armed…");
  off 01:52Z. Again on 04:13Z; off 06:42Z.
- Nov 6 22:29 `~/.ashlr/jev/config.json` rewritten `{"enabled": false}` —
  JEV = TypeSafe AI "System One" classifier (api.typesafe.ai,
  `TYPESAFE_API_KEY`), **not xAI**; `jev/decisions/` shows only local
  `jev-1.14.0` entries all window.
- Nov 7: `confinement.evidence-unknown` ×4 (kernel log stream unavailable),
  local-engine admission smoke tests failing.
- Nov 8 00:05Z `daemon:persistence-failed`: "failed to arm spend guard" →
  "continuous daemon stopped … paid work remains dispatch-blocked".
- Leader-requested goals *in* the window: "Live engine diagnostic: probe
  auth+execution for codex-cmp, codex-personal, grok, local, claude"
  (attempts a2f409a4 Nov 2, c1e71403/5c7cb124 Nov 3 — all `local-coder`,
  all failed at step 1) — the fleet was already trying to verify grok auth
  when the probes themselves died on the local lane.
- `~/.ashlr/incidents/` holds only a Sep 3 stats-test-contamination record;
  **no incident file for the xAI/Evero event.**

### 7. Credential exposure check

- Pattern `xai-[A-Za-z0-9]{20,}` (the shape `scrub-secrets.ts` redacts):
  **0 hits** across `audit/`, `judge-traces/`, `decisions/`, `routing/`,
  `dispatch-production/`, `agent-logs/`, `jev/decisions/`,
  `daemon.launchd.out.log`, `oversight.log`, `ashlr.log`,
  `session-log.jsonl`.
- `XAI_API_KEY=`/`GROK_API_KEY=` assignments: only pass-throughs
  (`${XAI_API_KEY}`) and doc/test placeholders (`xai-...`, `test-…`) inside
  repo mirror checkouts — no values.
- Custody ledger is value-free by design (phantom-custody.ts — "no paths,
  secret names, values or error strings").
- `~/.ashlr/secrets/typesafe.env`, `native-profiles/*/auth.json`,
  `~/.ashlr/keys/swarm.key` exist but were **never opened** — presence/mode
  only.

### 8. "JobBench"

- `rg -i 'jobbench|job-bench|job_bench'` across the phantom repo (src, docs,
  test), `~/.ashlr`, and worktree notes: **0 matches**.
- Closest artifacts: `src/cli/eval-swe-bench.ts` (`ashlr eval swe-bench`,
  default engine `local-coder`) with reports in `~/.ashlr/eval/` — only 4
  `bench-*.json`, all **2026-07-06**, engine not recorded as xAI.
- `~/.ashlr/best-of-n`, `agent-logs/best-of-n-*.log` are July-era;
  `judge-traces`/`decisions` are the live judge ledgers.

### 9. Worktree artifacts (`~/Projects/ashlrai/wt`, 910 dirs)

- 826 worktrees touched in window; `RQ-*` names are codenames —
  `RQ-ROUTINEGROKQ8` contains unrelated C17 restoration evidence.
- `rg 'grok|xai'` over window-era `BRIDGE_NOTES.md`: hits are code/test
  content (grokbot-lane docs, grok-ultra tests, "Grok 80 percent cut"
  router logic), not engines used.
- `~/.grok`, `~/.grok-lane`, `~/.codex`, `~/.phantom` etc. exist but are
  sandbox-protected (expected — seat/lane homes).

---

## Assumptions & open questions

- **Nov 7 judge failures cause — ambiguous.** `judge-parse-failure` means
  the CLI emitted output that wasn't a verdict (or empty). Consistent with
  (a) weekly subscription window exhausted (first reading = 100%), (b)
  account-level xAI/Evero access disabled, or (c) seat/binary breakage. The
  records do not say which; `attempt` run dirs under `~/.ashlr-runs` would.
- **What filled the weekly window.** No work assignments to grok-cli since
  Oct 14; ~75 light judge calls Nov 2–6 (diff-sized prompts, ~60 s each)
  plausibly contributed but may not alone reach 100% — consumption outside
  Phantom (interactive/other machines on the same account) can't be ruled
  out. The 100% reading may also be the provider's way of reporting a
  disabled account — flagged as unknown, not asserted.
- **"Evero key" ≠ seat credential.** The seat authenticates with OAuth
  `cached_token` (SuperGrok subscription); the Evero API key is a different
  credential that would feed the `grok` api-model engine — which has no
  usage evidence anywhere in the window (not in allowedBackends, no
  api-model records, llm.enabled=false).
- **`jobs.jsonl` / dispatchd logs** (`~/.ashlr-runs/metrics/jobs.jsonl`,
  `~/.ashlr-runs/**`): macOS sandbox denies all reads
  (`Operation not permitted` despite scope grant) — router-queue job
  history, per-attempt stdout, and lane-owned tool homes are unverified.
  Fixture copies under `test/fixtures/*/jobs.jsonl` are synthetic.
- **grok seat spawns Nov 2–6** aren't provable from custody (spawns.jsonl
  rotated; earliest Nov 7 06:43Z) — but successful `judge-noise` verdicts
  require live model output, so calls did run.
- **Nov 7 judge attempts ~12:00Z** are consistent with still-scheduled
  judge batches continuing after quota/auth broke — i.e., the judge kept
  *trying* xAI on Nov 7 but nothing billable succeeded (fail-closed).

## Bottom line

In the audit window the only xAI traffic attributable to Phantom/fleet was
the **proposal evaluation judge on the `grok-cli` SuperGrok seat** —
~15 judgments/day Nov 1–6 (real output, incl. Nov 2–5 inside the window),
failing entirely Nov 7 after the weekly window read 100% / access broke.
**No coding or research workloads ran on xAI Nov 2–7** — every attempt was
`local-coder` (and every attempt failed on the local lane). **No JobBench
artifact or run exists.** **No credential values were found in any
accessible log.** The API-key (`XAI_API_KEY`/Evero) engine was never
eligible to run — subscription OAuth is the only xAI credential the fleet
exercises.

## Evidence index (all read-only)

| Path | What it showed |
|---|---|
| `~/.ashlr/judge-traces/2026-1[01]-*.jsonl` | `grok-cli:grok-4.7` verdicts Oct 13–Nov 6 |
| `~/.ashlr/decisions/2026-11-0*.jsonl` | 15 judged/day; Nov 7 all `judge-parse-failure` |
| `~/.ashlr/custody/spawns.jsonl` | 30 unwrapped grok spawns Nov 7 12:00Z |
| `~/.ashlr/runs/attempt-*.json` (183) | all `local-coder`, all failed |
| `~/.ashlr/dispatch-production/2026-11-0*.jsonl` | all `local-coder` dispatches |
| `~/.ashlr/fleet/quota.json` | backend assignment ledger; grok-cli last Oct 14 |
| `~/.ashlr/routing/capacity{,-history}.json*` | grok weekly 100%, first read Nov 6 21:39Z |
| `~/.ashlr/routing/decisions*.jsonl` | grok excluded all window |
| `~/.ashlr/audit/2026-11-0*.jsonl` | kill switches, diagnostics, daemon stop |
| `~/.ashlr/native-profiles/grok-a/**` | seat spec, auth.json mtime, cached_token auth |
| `~/.ashlr/config.json`, `ashlr.yaml` | allowedBackends (no `grok`), llm.enabled=false |
| `~/.ashlr/jev/{config,decisions}` | TypeSafe classifier, disabled Nov 6 22:29 |
| `~/.ashlr/eval/bench-*.json` | SWE-bench reports, July only |
| `src/core/{run/engine-registry,run/phantom-custody,fleet/manager,inbox/merge}.ts` | engine/judge/custody semantics |
| `~/Projects/ashlrai/wt/*` | 826 window worktrees; no xAI-engine artifacts |
| `~/.ashlr-runs/**` | **inaccessible — sandbox (Operation not permitted)** |
