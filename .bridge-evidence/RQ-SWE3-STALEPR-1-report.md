# RQ-SWE3-STALEPR-1 — Stale-PR audit, `ashlrai/phantom`

**Date:** 2026-11-07 · **Base:** `master` @ `addfd8cb2` · **Scope:** all 228 open PRs

## Headline

**Zero open PRs are literally older than 30 days.** The oldest open PR is
**#878** (created 2026-10-19, 19 days). The "#924-era" the job describes is real
but younger: a single bridge wave of PRs created 2026-10-19 → 10-28 that has
seen **no activity since 2026-10-28**. Because no PR crosses the 30-day line,
this report audits the stale cohort the job intended: the **36 open PRs with no
update in ≥10 days** (last touched 2026-10-27/28). A wider tier of 65 PRs is
inactive ≥7 days; the extra 29 are 7–9 days idle and listed at the end.

Open-PR age profile (created / last-updated):

| Inactive for | Open PRs |
| --- | --- |
| ≥ 7 days | 65 |
| ≥ 10 days | **36 (audit set)** |
| ≥ 14 days | 1 (#878) |
| ≥ 30 days | **0** |

Of the 36, **35 conflict with current master** (verified locally with
`git merge-tree --write-tree`; the only clean PR is #878). The conflicts are
mostly mechanical: every bridge-era PR edits the hot registry files
(`docs/README.md`, `src/cli/help.ts`, `src/cli/completions.ts`,
`test/config/realio-lane-membership.mjs`, `docs/AGENT-OPERATIONS.md`).

## Verdicts

| Class | Count | PRs |
| --- | --- | --- |
| **superseded-by** | 11 | #924, #970, #1013, #1022, #1047, #1048, #1050, #1128, #1222, #1223, #1252 |
| **still-unique** | 17 | #927, #935, #950, #1044, #1045, #1058, #1099, #1111, #1123, #1135, #1156, #1161, #1166, #1185, #1260, #1261, #1271 |
| **needs-owner** | 8 | #878, #948, #976, #1072, #1136, #1149, #1175, #1267 |

## superseded-by (11) — intent already on master; recommend close

| PR | Title | Superseding evidence (commit / PR) |
| --- | --- | --- |
| #924 | ci: Windows portability + macOS legs only on platform PRs | `master:.github/workflows/ci.yml` already runs `windows, portability 1/3..overflow` lanes (commits `c911dff08`, `b22664f2e`, `e45a583a0`, `66d2d362c`) and the Oct-28 "merge fast, test later" policy resolved the leg-gating question differently (fast gate only on PRs; full suites 6-hourly on master; macOS never on PR). |
| #970 | bridge: RQ-LAUNCH-LOCK | `requireClone` fail-closed option in `scripts/bridge-worktree.mjs` landed via `07c984804` **RQ-MAC-DISK (#1005)**. Residual `scripts/mac-bridge/*` scaffold never landed. |
| #1013 | bridge: RQ-CYCLE-1-r3 | Same job landed at r2: `f9af54f0e` **RQ-CYCLE-1-r2 (#964)** brought `scripts/cycle/collect.mjs`, `test/cycle-collect.test.ts` (both exist on master under `scripts/cycle/`). |
| #1022 | bridge: RQ-BUS-1C | The 1-series landed elsewhere: envelope+schema via **RQ-BUS-1A (#1011)**, 1B via **(#1024)**, and the mailbox engine via `aae8481fa` **RQ-BUS-2 (#1134)** as `src/core/run/mailbox-engine.ts` + `docs/MAILBOX-ENGINE.md`. Bus contract now documented in `docs/AGENT-BUS.md` (v2). |
| #1047 | bridge: RQ-PARITY-GROK-DEVIN-PEERS | Both files exist on master: `bus-adapters/grok.ts` via **RQ-BUS-3B (#1021)**, `bus-adapters/devin.ts` via **RQ-BUS-3A (#1023)**. |
| #1048 | bridge: RQ-QUEUE-5 | Queue stats/journal/CLI landed via `1c7f1911e` **RQ-DRAIN-phantom-965 (#1340)**: `src/core/queue/stats.ts`, `journal.ts`, `cli/queue.ts`, `docs/QUEUE-STATS.md` all present. Only the web-ui `queue-stats/model.ts` is residual (covered in spirit by open sibling #950). |
| #1050 | bridge: RQ-DOCTOR-FAST | Parallel `getToolsRegistry({parallel:true})` + doctor call-site already on master (`tools-registry.ts:532`, `doctor.ts:137`); dedupe test landed via **RQ-DRAINPH957Q7 (#1555)**. Residual `src/doctor/{executable,tool-version-cache}.ts` unlanded but the performance intent shipped. |
| #1128 | ci: diet step 1, draft-defer custody, scope dep-audit | Superseded by the Oct-28 CI policy: `custody.yml` is schedule-only ("never per PR or per push"), `dependency-audit.yml` has `paths:` scoping, and ci.yml's daily-full model absorbed the diet framing. |
| #1222 | bridge: THROUGHPUT-PHANTOM-PATHS | `.github/scripts/ci-site-lane.mjs` exists on master since **#670**; Windows-portability lane reorganization already present; `realio-lane-membership.mjs` evolved past the PR's list. |
| #1223 | bridge: RQ-FAST-GATE-PHANTOM | The fast-gate model landed: ci.yml runs only a seconds-fast gate on PRs/merge queue (quick job + docs lane + `ci-site-lane`), full suites on schedule — the Oct-28 policy is this PR's intent, implemented differently. |
| #1252 | bridge: DESKTOP-PHANTOM | `custody.yml` now runs nightly-only (`schedule: 0 10 * * *`, "Daily full-suite policy (Mason, Oct 28 2026): macOS custody runs with the daily master run, never per PR"). The PR's schedule intent landed; its opt-in PR gate was explicitly rejected by the never-on-PR decision. |

## still-unique (17) — nothing on master covers the intent; keep or recut

All conflict with master; all are bridge-wave diffs that need a rebase (the
`RQ-REBASE-PH-*` fleet is already doing this for the newer 39xx-era cohort —
none of these are covered by it).

| PR | Title | Why still-unique |
| --- | --- | --- |
| #927 | Offline eval: local vs frontier routing | No `src/core/routing-eval/` or eval corpus on master (`scripts/evaluators/` has only preparation-*). |
| #935 | Coding CLI adapters + draft-PR worker plans | `src/core/providers/coding-cli/` absent (the same payload is embedded in the #948/#976 mega-bundles — if those land, this becomes superseded). |
| #950 | QueueStationGraph (RQ-QUEUE-5 frontend) | `QueueStationGraph.tsx`, `queue-stats/queue-now.ts` absent. Sibling #1048's backend half landed via #1340; the graph did not. |
| #1044 | bridge: RQ-FRESH-DOCS-DRIFT | No docs-drift checker on master (`scripts/check-docs-drift.mjs`, `docs/DOCS-DRIFT.md` absent). |
| #1045 | bridge: RQ-METRICS-IMPACT-SCORE | `metrics/impact.ts`, `decide/impact.ts` absent; landed bandit code even *comments* that `metrics/impact.ts` "is not present in this tree". |
| #1058 | bridge: RQ-METRICS-PROD-SHARE | `metrics/production.ts` absent (`fabric/production-velocity.ts` is unrelated daemon-lane glue). |
| #1099 | bridge: RQ-GROKBOT-OFFLOAD | `drive/mac-jobs.ts`, `drive/routines.ts` absent (RQ-NS-ROUTINES #1030 was automations templates, different thing). |
| #1111 | bridge: RQ-METRICS-DASH-FEED | `fleet/metrics-feed.ts` absent (master has `metrics-ingest.ts`, a different pipeline). |
| #1123 | bridge: RQ-PHM-CONNECT-WIZARD | No `src/cli/connect.ts` / `src/core/connect/*` on master (RQ-CONNECT*Q8 landings were copy/UX only). |
| #1135 | bridge: RQ-BUS-GROKBOT-R | Docs-only design note `GROK-BOT-BUS.md` absent; companion doc landed separately. Caveat: describes the v1-era bus; `AGENT-BUS.md` v2 now defines the real contract — close or rewrite to v2. |
| #1156 | bridge: RQ-MEM-RECLAIM | `memory/reclaim.ts`, `cli/mem.ts` absent (memory/ dir has pack/scope/etc. only). |
| #1161 | bridge: RQ-N26-CON-RULES-LINT | `constitution-check.ts`, `cli/constitution.ts` absent. |
| #1166 | bridge: RQ-N26-PH-DISPATCH-EVENTS-PARSER | `fabric/dispatch-events.ts`, `cli/fleet-events.ts` absent. |
| #1185 | bridge: RQ-RESEARCH-ROUTING-RL | `docs/research/routing-rl-ttc.md`, `scripts/evaluators/routing-off-policy.mjs` absent. |
| #1260 | bridge: RQ-IDEA-2026102703-1 | `improve/hot-patch.ts` absent (`improve/discover.ts` predates via #845). |
| #1261 | bridge: RQ-IDEA-2026102704-1 | `web/phantom-discovery.ts` absent. |
| #1271 | bridge: RQ-PH-CLI-COLDSTART | `scripts/benchmark-cli-coldstart.mjs`, `index-store.ts` absent; the lazy-startup half predates the PR (`d69ce7596`, Oct 10). |

## needs-owner (8) — a human call, not a mechanical one

| PR | Title | Situation |
| --- | --- | --- |
| #878 | docs: governed-client gateway opt-in design note | **On Mason's hold list** (AGENTS.md). Only clean-merge PR in the set; held ≠ abandoned. |
| #948 | bridge: RQ-FLEET-1-v2 | 80-file, 11.6k-line fleet-v1 mega-bundle; second revision of closed-unmerged #941; **shares 75/80 files with open #976**. Owner must pick one bundle to rebase (or recut into slices). |
| #976 | bridge: LAND-phantom-941 | Land-attempt of the same #941 payload as #948 — near-duplicate open PRs for one intent. Keep one, close the other. |
| #1072 | bridge: RQ-PL-FRESH-ECO-CL-JSON | Core `ecosystem/changelog.ts` landed via **RQ-PLAN-ECOCL-A (#1040)**; the PR's residual is a compact-JSON variant + generator script + doc. Decide if the compact format is still wanted. |
| #1136 | bridge: RQ-AUTO-LOCAL-1e | Design race: a *different* routing bandit landed via **RQ-OT-P1-BANDIT (#1677)** (contextual arm-registry sampler). This PR's two-arm local-vs-frontier lane chooser is unlanded but overlaps the same problem space. |
| #1149 | bridge: RQ-DV-SPLIT-FLEET-STATUS | Intent unlanded — `fleet/status.ts` is still a 7,801-line monolith — but the PR is an ±11k-line refactor that structurally conflicts; a rebase is really a re-do. |
| #1175 | bridge: RQ-OT-P3-HANDOFF-SCHEMA | Master grew different handoff machinery (`cli/fleet-handoff-pipe.ts`, `scripts/agent-wait-handoff.mjs`, `scripts/fleet-handoff-check.ts`); this schema-first design was overtaken — revive or retire? |
| #1267 | bridge: RQ-ONEASK-2-INTAKE | The one-ask series moved on: step-6 reward (`one-ask-reward.ts`) and ONEASKREWARDWIRE landed without ever taking step-2 `one-ask/intake.ts`. Confirm the intake design is still the plan. |

## Context for the closers

- **The whole stale wave is one batch.** 35 of 36 were opened 2026-10-26/28 and
  abandoned the same day (#878 is the lone Oct-19 outlier). Last-touch cluster
  on Oct 27–28 lines up exactly with the Oct-28 CI policy change ("merge fast,
  test later, fix forward daily") — the fleet likely stopped iterating these
  proposals when the merge model changed underneath them.
- **The fleet is already draining the *next* conflicting wave.** ~28 open
  `RQ-REBASE-PH-*` PRs (created Nov 7) rebase-or-supersede conflicting bridge
  PRs from the 39xx era, plus an `RQ-DRAIN2-PH-*` series. None of them target
  this ≤1271 cohort — these 36 are uncovered.
- **Mutual duplicates inside the open set:** only one true cross-PR dup —
  `RQ-QUEUE-5` = {#950 (frontend, still-unique), #1048 (backend, superseded)};
  plus the #948/#976 fleet-v1 pair (same payload, two open PRs).
- **Hold-list check:** of Mason's holds (phantom #197 #878 #743 #725 #738 #744
  #693 #1228) only **#878** is still open.

## Method & limits

- PR metadata via the unauthenticated GitHub REST API (`/pulls?state=open`,
  228 PRs; `gh` unusable — no readable config/token). Read-only.
- Heads fetched via `git fetch origin refs/pull/N/head`; conflict status via
  `git merge-tree --write-tree` against `master@addfd8cb2` — matches GitHub's
  "conflicting" semantics but not its UI flag.
- Supersession verified by file existence on master + `git log -S`/`--grep`
  landing-commit attribution, not by diff-equivalence proofs; a "superseded"
  verdict means the PR's *intent* is on master, not that its diff is byte-equal.
- Not evaluated: CI check state, review comments, PR bodies beyond titles.
  "needs-owner" = the mechanical signal is ambiguous; a human reads the PR.
- 29 PRs inactive 7–9 days (not audited individually): #915, #929, #932, #949,
  #966, #1384-era through ~#1700s bridge PRs — worth the same pass next cycle.
