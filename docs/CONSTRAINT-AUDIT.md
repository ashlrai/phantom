# Fleet constraint audit (RQ-CONSTRAINT-AUDIT-1)

Status: audit plus one low-risk relaxation, 2026-11-16. Source baseline is
`6015103469`. This is the action layer over the
[constraints ledger](strategy/CONSTRAINTS.md) (RQ-RETHINK-CONSTRAINTS-1). The ledger
records *why* each family exists. This file classifies each constraint for removal or
retention, names the next PR and records what this change already did. IDs in brackets
such as [Q05] refer to ledger rows.

Mason's directive is to remove as many constraints as possible and keep the hard
floor. No row below grants a bypass. A "relax" or "remove" verdict needs its own
reviewed PR. Every `contrib/mac/*` change also needs a Security re-pin before
installation. No operator lane installs a repository copy over the live one.

## Scope and limits of evidence

- **Read:** the repository copies of `contrib/mac/dispatchd.py` and the
  scripts beside it, `scripts/bridge/launch.sh`, `contrib/mac/sandbox/*`, the node
  pool (`src/core/drive/nodes/*`), the fleet, merge and lane autopilots, the
  dispatch router, backpressure and merge gates.
- **Not readable:** `~/.ashlr-runs` (the live `slots.json`, `budget-overrides.json`,
  the installed `launch.sh`, the sandbox `.sb` profiles and `lane_adapt.py`). The
  sandbox denied access, as it should. `lane_adapt.py`, `PINNED_MAX` and
  `SPEND_CAP` do not exist in this checkout. `PINNED_MAX = {"agy": 3}` appears only
  in the staged `contrib/mac/host-integration/dispatchd.candidate.py`. Live values
  can differ from the source defaults quoted here.
- **What "dead" means:** no runtime caller or reader exists in this checkout. A
  host-only caller cannot be ruled out, so every "remove" verdict starts with a
  live-host grep.

## Classes and actions

| Class | Meaning | Default action |
| --- | --- | --- |
| hard-floor | On Mason's floor: secret gate, sandbox, leader pins, secret-leaking workflow diffs, MACCU TCC and loopback auth, no force-push, no ruleset or admin bypass, no `~/.codex` auth change, no billing change, no secret values in logs, private-to-public stays human | keep |
| safety-critical | Not on the floor, but removing it can lose work, double-spend, corrupt state or starve the host | keep, or automate in place |
| historical | Correct when added. Now a fixed number or one-off ID where measured evidence or newer machinery should decide | relax or merge |
| overly-conservative | Blocks useful work with no matching protection | relax |
| dead | No reader, inert by default, or superseded | remove (after a live-host check) |

## Implemented in this change (zero or low risk)

| Constraint | Class | Change | Why it is safe | Tests |
| --- | --- | --- | --- | --- |
| Route minimum residency on a provider-backed-off lane [Q05] (`route_decision`, `work_market.hard_down`) | overly-conservative | An unlaunched job may leave a lane held by autobackoff (usage, quota or auth line) or by credit exhaustion before the 60-minute residency ends. Previously only `auth_failed: true` or `quota: 0` allowed this, so work sat for up to an hour behind a lane that could not run it. | The rule matches `fleet_controller.reroute_sources` and the documented phase C design ("a backed-off pool counts as `hard_down`"). Manual holds and operator HOLD-list lanes still never count. The two-moves-per-6-hour cap and the launched-pool lock still bind, so no job moves after launch and none runs twice. Cost-class and metered-lane exclusions in `work_market.choose` are unchanged, so spend cannot widen. | `test_work_market.py`: `test_hard_down_evidence`, `test_autobackoff_hold_releases_residency_but_not_move_cap_or_launch`. `test_route_hysteresis.py`: extended dispatcher-tick evidence table and the HOLD-list case. |
| Duplicate hard-down rule (`dispatchd.py` route reconciliation vs `work_market.hard_down`) | historical | Merged: route reconciliation now calls the single `work_market.hard_down(slot, operator_hold)`. The claim-time hysteresis call passes the HOLD list too. | Same predicate in all three call sites. The only behaviour change is the row above. | as above |
| `AB_MAX = AB_CAP` alias in `dispatchd.py` | dead | Removed. Nothing read it. `AB_CAP` (24 h) still bounds every autobackoff hold. | No reader in the repository or tests. | full `contrib/mac/tests` suite |
| Devin limits comment "10/3/16 by default" in `dispatchd.py` [L04] | historical | Corrected to the real `DEFAULT` of target 6, floor 3, ceiling 10. | Comment only. | n/a |

Docs updated with the change: [route hysteresis](ROUTE-HYSTERESIS.md) and AGENTS.md.

## Audit table

Paths are under `contrib/mac/` unless shown otherwise. The PR column suggests a
follow-up ID. "Pin" means a Security re-pin is required before live install.

### Hard floor (keep, never relaxed by an agent)

| Constraint | Class | Evidence | Action | Risk if removed | PR |
| --- | --- | --- | --- | --- | --- |
| `publish.sh` scrub.pl `--check` on diff and notes, `PUBLISH-ABORT secret-shape`, log scrub at exit [S01, S09] | hard-floor | `publish.sh` scrub calls. Dispatcher keeps `PUBLISH-ABORT` worktrees for supervisor review | keep | Secret disclosure | — |
| Publisher sensitive-path regex (`SRE`), G1 classifier, one-shot `g1-pass`, category-3 workflow abort [S09, S11] | hard-floor | `publish.sh` G1CLASSIFY and SRE | keep | Workload rewrites its own exfiltration barrier; secret-leaking CI | — |
| `.npmrc` deny, dependency-link guard | hard-floor | `publish.sh` `DEPENDENCY_LINK_GUARD` | keep | Registry credential or path redirection | — |
| Fork-only push, `fg_check`, pinned git-safe sha, credential/proxy reset [S06, S08] | hard-floor | `publish.sh`, `GITSAFE_SHA` in `dispatchd.py`, `integrated-merge.py` `GS_SHA` | keep | Push to upstream or redirected target | — |
| 7-repo publish, restock and staged-drain allowlists | hard-floor | `publish.sh`, `restock.py` `GS_REPOS`, `staged_drain.py` `ALLOWED`, `postrun_pr.py` | keep | Work published to an unvetted repository | — |
| Restock `HOLD-SECURITY` parking of `.github`, `publish.sh`, git-safe, scrub and reap surfaces | hard-floor | `restock.py` `SEC` and `NEGS` | keep the floor. Narrowing the bare words is a follow-up (below) | Agent edits its own gate | — |
| SB-17 deny (`launchservicesd`, `appleevent-send`), sandbox sha pins, `apply-sb17.sh` [S10] | hard-floor | `sandbox/sb17-block.sb`, `SHA256SUMS` | keep | Sandbox escape | — |
| Worktree containment before git (`ab_contained` denies `~/.codex*`, `~/.phantom`, Keychains, the runs dir) | hard-floor | `dispatchd.py` | keep | Agent-controlled path reaches credential stores | — |
| Loopback-only health probes (no redirects, no proxy, numeric 127.0.0.1) [S13] | hard-floor | `dispatchd.py` `loopback_health` | keep | Local task data sent to an external endpoint | — |
| Autobackoff stores no log text; anchored provider lines only | hard-floor | `dispatchd.py` `ab_scan` comment and code | keep | Secret values in logs and events | — |
| `integrated-merge.py` operator receipt (≤1800 s, 0600, owner uid, nlink 1) | hard-floor | `integrated-merge.py` | keep | Forged merge authority | — |
| Arm gate `HARD` checks (Merge Gate, secret scans, generated files, Fast gate) | hard-floor | `arm_gate.py` | keep | Auto-merge past a secret or merge failure | — |
| Merge autopilot never uses `--admin`, rebase or force-push; PR autopilot `WEAKENING` refusals | hard-floor | `src/core/fleet/merge-autopilot.ts`, `src/core/autopilot/diagnose.ts` | keep | Ruleset bypass; tests weakened to go green | — |
| Owner stop files: `~/.ashlr/KILL`, runs `PAUSE`, `KILL`, `HOLD` [S14, O02] | hard-floor (consent) | `dispatchd.py` `hold` and `pause`, `src/core/drive/nodes/worker.ts` `nodeStopped`, dispatch router | keep. Add reason and expiry metadata, never auto-clear | Acting after consent is withdrawn | RQ-HOLD-METADATA-1 |
| Metered lanes never a fallback destination; `claude-api` paced by its helper [L05, Q12] | hard-floor (billing) | `fleet_controller.REROUTE_DEST`, `work_market` cost classes, `batcher.BATCH_LANES` | keep | Unapproved spend | — |
| Devin `-lightning` paid model block (`PAID_MODEL_BLOCKED`) | hard-floor (billing) | `README.md` candidate selector | keep | Paid overage | — |

### Safety-critical (keep, or automate in place)

| Constraint | Class | Evidence | Action | Risk if removed | PR |
| --- | --- | --- | --- | --- | --- |
| Tick lock, `SlotWriter` single writer, `ready.lock` with a 10 s timeout [D15, D27] | safety-critical | `dispatchd.py` | keep | Double launch, queue corruption | — |
| Unknown process snapshot or lsof result exits the tick | safety-critical | `dispatchd.py` liveness | keep | Reaping or relaunching a live job | — |
| Launched pool is immutable; invalid `route-state.json` holds the tick [Q07] | safety-critical | `route_decision` `launched` | keep | Double execution, misattributed usage | — |
| Route move cap of 2 per 6 h [Q06] | safety-critical | `route_decision` | keep for now. Revisit after the residency relaxation shows real move counts | Ping-pong routing | RQ-ROUTE-MOVECAP-1 |
| Fix-main and drain single writer per target [Q14] | safety-critical | `fix_main_repos`, `drain_targets` | keep | Concurrent writers on one PR or main | — |
| Finished worktree awaiting reap is never doubled up | safety-critical | `dispatchd.py` launch loop | keep | Work loss | — |
| Max job runtime 7200 s (`0` disables, minimum 300 s), SIGTERM then SIGKILL after 30 s | safety-critical | `JOB_MAX_RUNTIME_S` | keep; already tunable per lane | Slot leak from wedged wrappers | — |
| Admission gate: load1 > 2×ncpu, memory pressure ≥2, swap growth >2 GB per 300 s, disk <30 GB [D02, D04, D05, D07] | safety-critical | `admission_gate()` | keep the gate; calibrate the thresholds from measured saturation | Host starvation, swap thrash, full disk | RQ-LOADGATE-CALIBRATE-1 |
| Required phase deadlines and `_run` process-group kill [D17, D19] | safety-critical | `tick_phase`, `_run` | keep | Wedged supervisor, orphan grandchildren | — |
| `hard_cap` clamp after overrides | safety-critical | `clamp_lane` | keep | Overrides lift a pool past the operator cap | — |
| oMLX memory cap (`min(6, memsize // 32 GiB)`, unknown means 0) [D10] | safety-critical | `omlx_memory_cap` | automate from measured model memory | Local memory exhaustion | RQ-OMLX-MEMFIT (live claim `RQ-OMLXFITN16IQ8` covers this) |
| Precheck park backoff, empty streak 2, code 13 parks and never retires [Q08] | safety-critical | `launch_precheck.py` | keep | Repeated no-op spend; false completion | — |
| Concurrency floor 4, ceiling 64 [D12] | safety-critical | `concurrency.py` | keep; env-tunable already | Unbounded sessions | — |
| Node pool witness: primary admission closes when the backup witness is unreachable | safety-critical | `src/core/drive/nodes/pool-host.ts` | keep (split-brain protection). Document the single point of failure | Two primaries claim the same job | — |
| Node lease TTLs (node 30 s, leader 10 s, claim 30 s) and failover after 15 min | safety-critical | `src/core/drive/nodes/index.ts`, `pool.ts` | keep | Double claim | — |
| Staged-drain local branch for `.github` and `release*` rows | safety-critical | `staged_drain.py` | keep. Make the scrub check fail closed when `scrub.pl` is missing (currently fails open; local-only, so low risk) | Inconsistent secret handling | RQ-STAGED-DRAIN-SCRUB-1 (pin) |

### Historical (relax or merge)

| Constraint | Class | Evidence | Action | Risk if removed | PR |
| --- | --- | --- | --- | --- | --- |
| Route minimum residency of 3600 s on a healthy but congested lane [Q05] | historical | `route_decision` | **partly relaxed here** for provider-backed-off lanes. Next: replace the fixed hour with a stability penalty | Route churn | RQ-ROUTE-RESIDENCY-2 (pin) |
| Duplicate hard-down predicates | historical | `dispatchd.py` and `work_market.py` | **merged here** | — | done |
| `MAX_LAUNCH_PER_TICK = 8` [D01] | historical | `dispatchd.py` | relax to remaining phase time plus admission gate | Spawn burst; the admission gate still bounds it | RQ-LAUNCH-PER-TICK-1 (pin) |
| Disk reuse-only kinds below 100 GB [D08] | historical | `DISK_REUSE_ONLY_GB`, `REUSE_KINDS` | relax: reserve measured bytes per worktree; keep the 30 GB hard stop | Disk fill; the hard stop remains | RQ-DISK-RESERVE-1 (pin) |
| Phantom publish drip at ≥400 open PRs vs restock's MERGERATE cap of 150 | historical | `PH_DRIP_MAX` in `dispatchd.py`; hard-coded 150 in `restock.py` | merge into one named constant with a single owner | Inconsistent backlog policy | RQ-OPENPR-CAP-MERGE-1 (pin) |
| `PUBLISH_DRIP` fixed 10 pushes per 5 min, none at ≥150 queued runs | historical | `dispatchd.py` | relax to Actions-queue feedback (the `PUBLISH_HOLD` auto-release already measures it) | Actions stall | RQ-PUBLISH-DRIP-1 (pin) |
| Devin step-down floor 6 vs lane floor 3 [D21] | historical | `DEVIN_STEP` vs `DEFAULT["devin"]` | keep the behaviour (Masbot Oct 26); document both floors in one place | — | docs only |
| Concurrency ramp: +2 per 120 s, 900 s settle [D14] | historical | `concurrency.py` | tune from measured headroom | Oscillation | RQ-CONC-TUNE-1 (pin) |
| Local size admission: restock 80 vs dispatcher 60 [D29] | historical | `restock.local_fit`, `dispatchd.py` `_size_hint > 60` | merge into one threshold | Local jobs bounce between producer and dispatcher | RQ-LOCAL-SIZE-MERGE-1 (pin) |
| Batch bounds 2/8/10, 200000 chars, 2 attempts, 4 h [Q10] | historical | `batcher.py`, `batch_sessions.py` | automate from per-bundle yield | Overlarge sessions | — |
| Devin batch route phantom-only (`eligible_repos`) | historical | `batch_sessions.py` | relax to the fleet allowlist once the Devin repo setup exists | Devin session without repo setup | RQ-DEVIN-REPOS-1 |
| Hard-coded hold PR numbers in `branch-gardener.py` [S16] | historical | `branch-gardener.py` `HOLDS` | **Mason decides.** Source age is not evidence of release | Deletes branches Mason parked | owner |
| One-off PR tuples (plugin#157, lexicon#479/#480) in `integrated-merge.py` and the squash override in `publish.sh` | historical | `integrated-merge.py`, `publish.sh` | remove once those PRs are closed or merged | None after landing | RQ-ONEOFF-PR-CLEANUP-1 (pin) |
| `LOCAL_MID_CAP` 1/2/4 [D11] | historical | `dispatchd.py` | automate from local runtime occupancy | Local inference overload | — |
| Merge autopilot: 3 actions per PR per 24 h | historical | `src/core/fleet/fleet-merge-state.ts` | relax to a per-head-SHA budget | update-branch loops | RQ-MERGE-AUTOPILOT-BUDGET-1 |

### Overly conservative (relax)

| Constraint | Class | Evidence | Action | Risk if removed | PR |
| --- | --- | --- | --- | --- | --- |
| Restock `SEC` bare words `dispatchd`, `reap`, `scrub` park ordinary dispatcher and reaper work as HOLD-SECURITY | overly-conservative | `restock.py` `SEC` | narrow to path tokens (`contrib/mac/dispatchd.py`, `scrub.pl`, `reap-one.sh`). Security must review: this is the classifier for the hard floor | Under-parking a real gate edit | RQ-SEC-CLASSIFIER-NARROW-1 (Security) |
| Restock skip regex matching bare `owner` or `standing` in the first 200 characters | overly-conservative | `restock.py` | anchor to the explicit owner-authored markers | Agents pick owner-reserved work. Keep the explicit markers | RQ-RESTOCK-SKIP-NARROW-1 (pin) |
| Claude lane target 0 by default [L03] | overly-conservative | `DEFAULT["claude"]`, `restock.py` need 0 | **Mason decides** account admission; zero target is not evidence of exhausted quota | Subscription use without intent | owner |
| Node capacity is held at memory pressure level 2 and a running job is SIGKILLed when capacity turns held | overly-conservative | `src/core/drive/nodes/capacity.ts`, `host-headroom.ts`, `worker.ts` | stop new claims at level 2; SIGKILL only at level 4 (critical) | Host swap thrash; killing in-flight work at a warning loses work today | RQ-NODE-PRESSURE-1 |
| Non-darwin nodes always `memory-unmeasured`, so 0 slots | overly-conservative | `src/core/drive/nodes/capacity.ts` | add a Linux `/proc/meminfo` reading | Linux nodes stay unusable | RQ-NODE-LINUX-HEADROOM-1 |
| Pool capacity freshness of 2×heartbeat (6 s) vs node offline at 300 s | overly-conservative | `src/core/drive/nodes/router.ts` | widen to about 3 heartbeats plus SSH latency | Stale capacity; the claim still re-checks | RQ-NODE-FRESHNESS-1 |
| Muse light restock requires `slots === 2` exactly | overly-conservative | `src/core/drive/nodes/light.ts` | change to `>= 1` | — | RQ-MUSE-LIGHT-SLOTS-1 |
| Unknown presence treated as present (local slots 2) | overly-conservative | `src/core/fleet/dispatch-router.ts` `PRESENCE_LOCAL_SLOTS` | **Mason decides**: an interactive-reserve question | Fleet competes with Mason's local session | owner |
| Backpressure `maxOpenFleetPrsPerRepo = 3` makes the land-first limit of 30 unreachable | overly-conservative | `src/core/fleet/backpressure.ts`, `dispatch-router.ts` | raise to the land-first limit or merge the two | PR flood; Merge Gate still bounds landing | RQ-BACKPRESSURE-OPENPR-1 |
| Local-enforcement merge cap of 4 per day | overly-conservative | `src/core/authority/types.ts`, `merge-gates.ts` | **Mason decides**: signed-authority volume | Merge volume beyond the grant | owner |
| Repo with no checks (`checks.state 'none'`) never actionable by merge autopilot | overly-conservative | `merge-autopilot.ts` | keep held (no CI evidence is not green) | Merging unverified code | keep |
| `arm_gate.py` `EXPECTED` checks wait even though they have not failed recently | overly-conservative | `arm_gate.py` docstring | relax to informational after a measured window | Missing a typecheck failure; Merge Gate still runs it | RQ-ARM-EXPECTED-1 (pin) |
| `install-gate.py` serialises even cache-hit installs (1800 s wait) [D26] | overly-conservative | `install-gate.py` | allow N concurrent installs sized from disk and CPU | Install storms | RQ-INSTALL-GATE-N-1 (pin) |
| `lane-autopilot` `--overrides` without a compact block jumps compact1 to 300 GB | overly-conservative | `src/core/resources/lane-autopilot.ts` `COMPACT_CONFIG_DEFAULTS` | fall back to `DISK_THRESHOLDS` when the block is absent | Raises frozen below 300 GB free | RQ-LANE-AUTOPILOT-COMPACT-1 |

### Dead or inert by default (remove after a live-host check)

| Constraint | Class | Evidence | Action | Risk if removed | PR |
| --- | --- | --- | --- | --- | --- |
| `AB_MAX` alias | dead | no reader | **removed here** | none | done |
| `queue/LOADGATE_OFF` | dead (by design) | reported as `off_switch_ignored`, never waives | keep the reporting so operators see it is inert; delete the file on hosts | none | ops |
| Fleet controller phases B and C (`FLEET_CTL_MODE` defaults to `shadow`) [D24] | dead by default | `dispatchd.py` `FC_ENFORCE`; no repo plist sets `enforce` | decide: enable enforce after the shadow ledger review, or delete phases B and C. Backpressure (`queue/backpressure.json`) is read by `dispatchd.py` but binds only in enforce | Phase C rebalance never helps today | RQ-FLEET-CTL-ENFORCE-1 (pin) |
| `launch_cost.py` | dead at runtime | only `test/mac/test_launch_cost.py` imports it; no runtime caller | wire it into the launch receipt or delete it with its test | none | RQ-LAUNCH-COST-DECIDE-1 |
| `host_pressure_admission.py` | staged, not dead | hash-pinned by `host-integration/launch.candidate.sh`; adoption pending | keep until the candidate is adopted or abandoned. Its level-2 hold matches the node-pool item above | — | with RQ-NODE-PRESSURE-1 |
| `src/core/fleet/autopilot.ts` planner | dead | only `test/fleet-autopilot-recut-c405.test.ts` imports it; the advertised `phm fleet autopilot` verb does not exist | delete it with its test, or wire the verb | none | RQ-FLEET-AUTOPILOT-PLANNER-1 |
| `lane-autopilot` targets | inert | printed by `phm resources autopilot` only; no writer | keep as a report; do not treat as a constraint | — | — |
| `publish.sh` CODEOWNERS `T1` match | dead as a gate | informational only | remove the branch or label it advisory | none | RQ-PUBLISH-T1-CLEANUP-1 (pin) |
| `PUBLISH_FULL_TESTS` default 0 | inert | `publish.sh` | keep off; Merge Gate is the required hosted check | — | — |
| Judge gate without `PUBLISH_JUDGE_CMD` | inert | `publish.sh` | keep: opt-in by host | — | — |
| `held_reason == "auth_failure"` clause in `hard_down` | possibly dead | no writer in this checkout; an operator may write it by hand | keep (harmless, forward-compatible) | — | — |

## Possible defects found (not constraints)

| Finding | Evidence | Suggested PR |
| --- | --- | --- |
| A node worker returns `unsupported-job` without releasing the pulled claim, which then waits out the 30 s claim TTL | `src/core/drive/nodes/worker.ts` pull path | RQ-NODE-UNSUPPORTED-RELEASE-1 |
| The merge-autopilot pending-check age is measured from PR open, not the head push, so an old PR with a fresh push can turn red early | `src/core/fleet/merge-autopilot.ts` `pendingSinceMs = pr.openedAt` | RQ-MERGE-PENDING-AGE-1 |
| `self-supply.py` does not consult `queue_gate`, so it can overfill past the depth target that restock respects | `self-supply.py` | RQ-SELF-SUPPLY-GATE-1 (pin) |

## Follow-up order

1. RQ-NODE-PRESSURE-1, because killing in-flight work at a pressure warning loses
   work today.
2. RQ-ROUTE-RESIDENCY-2 and RQ-ROUTE-MOVECAP-1, once `ROUTE` and `ROUTE_HOLD`
   counts from this change are visible in `dispatch-events.log`.
3. RQ-OPENPR-CAP-MERGE-1 and RQ-BACKPRESSURE-OPENPR-1: one open-PR policy.
4. RQ-LAUNCH-PER-TICK-1 and RQ-DISK-RESERVE-1.
5. Owner decisions: the claude lane target, unknown presence, the local merge
   cap and the branch-gardener hold list.
