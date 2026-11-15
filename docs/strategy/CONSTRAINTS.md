# Constraints and guardrails ledger

Status: docs-only proposal for RQ-RETHINK-CONSTRAINTS-1. Source baseline:
`00b72c2ea60de124051bb687a80f94663378d3b5`, inspected 2026-11-13.
No secret values. Publication remains fork-only through `publish.sh`.
This ledger changes no gate, grant, hold, required check, pin or installed file.

The highest-value changes remove fixed waiting and throughput limits while
retaining mechanical checks on secrets, money, identity, private information and
destructive actions. Agent judgment should select work and repair failures;
deterministic enforcement should bound irreversible effects. Resource admission,
timeouts and locks still protect useful work even though they are not human
approval gates.

## Coverage and evidence

This is an inventory of the constraint families in the supplied task sources and
their checked-in consumers, with adjacent authority, release, desktop and send
paths included. It is not a claim that every literal in every package or every
deployed host was audited. Rows group closely related checks only when they share
an enforcement boundary, protection and verdict. Numeric values below are source
defaults, not measurements of the running fleet.

| Evidence | What was established | Remaining limit |
| --- | --- | --- |
| [AGENTS.md](../../AGENTS.md), [constitution](../../CONSTITUTION.md), [standing authority](../STANDING-AUTHORITY.md) | Written restrictions, explicit holds, signed grant model and policy conflicts | Doctrine alone does not prove runtime enforcement |
| [Dispatcher](../../contrib/mac/dispatchd.py), [concurrency](../../contrib/mac/concurrency.py), [controller](../../contrib/mac/fleet_controller.py) | Current source consumers, thresholds and defaults | Repo candidate is not the installed digest |
| `~/.ashlr-runs/queue/slots.json` and `budget-overrides.json` | Exact-path, numeric/boolean-only projection attempted; both returned permission errors | Current targets, holds, stops and account reserves are **unknown**; no broader host or credential discovery attempted |
| [Publisher mirror](../../contrib/mac/publish.sh), [machinery manifest](../../fleet/manifest.json) | Fork, diff, workflow and pin boundaries in source | Live `scrub.pl`, complete lane `.sb` profiles, leader wrappers/prompts/plists and release signer are host-owned; installed content unverified |
| [SB-17 patch](../../contrib/mac/sandbox/NOTES.md), [profile fragment](../../contrib/mac/sandbox/sb17-block.sb) | Reviewed deny operations and adoption procedure | One fragment does not prove the effective full sandbox |
| [CI workflow](../../.github/workflows/ci.yml), [merge gate implementation](../../src/core/fleet/merge-gates.ts) | Source-selected checks and exact-candidate validation | Current GitHub rulesets, reviews, holds and CI outcomes unverified; connector search failed argument binding and `gh` config access was denied |
| Supplied fleet snapshot | No listed live claim or displayed PR covers this ledger | Snapshot is partial; current remote duplicate check unavailable |

### Verdicts

| Verdict | Meaning and implementation requirement |
| --- | --- |
| KEEP-HARD | Preserve the security or irreversible-effect boundary. Mechanical enforcement is preferred; this label does not imply a human must approve each execution. |
| AUTOMATE | Keep the protective invariant, replace repeated judgment or fixed tuning with measured enforcement, receipts, expiry or reconciliation. Existing mechanical controls also use this label. |
| CUT | Remove the named redundant policy or arbitrary threshold in a separate implementation change. Retain the replacement protection named in the row. This recommendation grants no bypass authority. |
| RETHINK | A stated owner choice, signed scope, unresolved policy conflict or unknown boundary needs Mason's decision. Until resolved, current restrictions remain effective. |

Cost is qualitative: no production latency, idle-slot, dollar-saving or throughput
claim is inferred from source constants. IDs are stable handoff references.

## Security floor and explicit holds

Where a row cites AGENTS, it refers to [Article 1 and kept limits](../../AGENTS.md#article-1-full-autonomy-always-forward).
Security GATES v3 is referenced there; no separate complete canonical GATES v3
specification was found in this checkout. Do not infer it from older G1/G2 labels.

| ID and constraint | Where enforced or specified | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| S01 Secret values never in context, logs, notes or Git | AGENTS; [scrubSecrets](../../src/core/util/scrub-secrets.ts), [scrub wrapper](../../src/core/util/scrub.ts), publisher pre-push checks | Irretrievable credential disclosure | False positives and scan work | KEEP-HARD. Scan every egress, including errors, artifacts and notes. |
| S02 Vault value-blindness and named references only | [Toolchain](../AGENT-TOOLCHAIN.md), [connector validator](../../src/core/connectors/profile.ts) | Agent access to raw credentials | Integration through scoped execution | KEEP-HARD. Resolve handles only in trusted execution; never propose value inspection as diagnosis. |
| S03 Credential creation, rotation, revocation and account auth changes | AGENTS; constitution Always ask; connector import exclusion for `~/.codex` | Account loss and identity takeover | Human ceremony | KEEP-HARD. Retain custody and explicit authorization for these effects. |
| S04 Spending, billing, paid plans and payments | AGENTS; [budget policy](../../src/core/routing/policy.ts); standing grant spend scope | Unapproved financial liability | Paid capacity unavailable without authorization | KEEP-HARD. Existing credit balances or quota readings are not spending permission. |
| S05 Private code, data and owner messages stay private | Constitution Articles 1/9; [iMessage isolation](../IMESSAGE.md) | Irreversible public disclosure | Audience verification | KEEP-HARD. Verify visibility and recipient scope at the actual egress. |
| S06 No force-push to default, repository deletion or admin/ruleset bypass | AGENTS; [safe Git](../../src/core/sandbox/safe-git.ts); GitHub protections where configured | Destruction and evasion of server checks | Normal PR path | KEEP-HARD. No approval shortcut in this ledger authorizes a bypass. |
| S07 No destruction of Mason's files, accounts, mail or data | Constitution Article 9; [disk protect list](../DISK-MAINT.md) | Irrecoverable owner data loss | Narrow cleanup scope | KEEP-HARD. Rebuildable task artifacts need proof before deletion. |
| S08 Fork-only publication and real-fork verification | AGENTS; publisher `fg_check`, fixed HTTPS target | Pushes to upstream or redirected targets | API lookup before push | KEEP-HARD. Fail closed on parent/name/fork mismatch or unavailable evidence. |
| S09 Pins on scrubber, secret-shape gate and publisher | AGENTS; [manifest pinned class](../../fleet/manifest.json); publisher sensitive-path regex | Workload rewriting its own exfiltration barrier | Security review and digest handoff | KEEP-HARD. Never self-repin or install a candidate. |
| S10 Sandbox, leader wrapper/prompt/plist pins | AGENTS; [sandbox handoff](../../contrib/mac/sandbox/NOTES.md); host launcher | Escape from task scope or privileged leader instructions | Security review of small trusted surface | KEEP-HARD. Resolve source/publisher pin-scope drift in R02 before any relaxation. |
| S11 Secret-leaking workflow diff review | Publisher category-3 classifier; AGENTS | Token exfiltration through CI | Exact-tree Security pass | KEEP-HARD. New secret references, privileged triggers, id-token and unpinned actions stay covered. |
| S12 MACCU TCC helper and authenticated loopback pins | AGENTS; [app drive](../APP-DRIVE.md) | Unauthorized OS or local service control | Security pin and device approval | KEEP-HARD. No TCC database editing or loopback auth weakening. |
| S13 Local models restricted to loopback | Dispatcher `loopback_health`; [routing policy](../../src/core/routing/policy.ts) | Sending local-task data to an external model endpoint | Local readiness checks | KEEP-HARD. Preserve numeric-loopback validation, proxy exclusion and redirect refusal. |
| S14 Owner stop, pause and revocation override automation | [Standing authority](../STANDING-AUTHORITY.md), dispatcher PAUSE/HOLD, [comms policy](../COMMS-AGENT.md) | Acting after consent was withdrawn | Immediate interruption | KEEP-HARD. Read stop state at action boundaries; do not clear it as routine recovery. |
| S15 Outside-team sends require owner authority | Constitution Article 9; [Comms agent](../COMMS-AGENT.md), [drafts](../DRAFTS.md) | Irreversible communication on another person's behalf | Draft/approval latency | KEEP-HARD. Bind authorization to transport, recipient and content where required. |
| S16 Mason's named issue holds | AGENTS and constitution Article 1, policy only here | Overriding deliberate owner exclusions | Work remains parked | RETHINK. Mason must release or confirm each hold; source age is no evidence of release. |
| S17 Release signing and live release machinery custody | AGENTS release instructions; [manifest](../../fleet/manifest.json) | Compromise of production publisher/signing identity | Security pin and sanctioned workflow | KEEP-HARD. Never install repo release scripts over live scripts or LaunchAgents. |

S16 inventory, preserved verbatim as issue identifiers:

- phantom: #197, #878, #743, #725, #738, #744, #693, #1228.
- phantom-secrets: #140, #197, #375, #168, #418, #136.
- ashlr-plugin: #152, #157.

## Dispatcher admission, concurrency and time budgets

Source for D rows is [dispatchd.py](../../contrib/mac/dispatchd.py) unless another
file is linked. `MAX_LAUNCH_PER_TICK` is an actual launch-loop limit through
`GATE["claim_limit"]`. Process count, worktree count and daemon tick age in the
current admission gate are warnings, not hard launch stops.

| ID and constraint | Where enforced, source default | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| D01 Launches per tick | `MAX_LAUNCH_PER_TICK = 8`, launch loop and rebalance limit | Sudden spawn bursts | Idle capacity waits for another tick | CUT. Replace fixed count with remaining phase time, resource admission and bounded spawn rate. |
| D02 Load stop | `GATE_LOAD_PER_CPU = 2.0`; stop when load1 exceeds multiplier x CPU count | Host starvation | Delays even mostly remote work during local load | AUTOMATE. Calibrate against dispatch latency and measured saturation; retain a host-health stop. |
| D03 Old absolute load ceiling | [Staged host candidate](../../contrib/mac/host-integration/dispatchd.candidate.py): `GATE_LOAD_MAX = 36`, min with 2 x CPUs | Historical overload proxy | Machine-size-dependent underuse | CUT. Retire stale absolute ceiling from staged successors; canonical dispatcher already uses D02. No claim it is live. |
| D04 Memory pressure stop | `GATE_PRESSURE_MIN = 2`; unavailable pressure warns | Swap thrash and OS instability | Admission stops on warn pressure | AUTOMATE. Keep pressure admission with explicit missing-signal handling and recovery hysteresis. |
| D05 Swap-growth stop | More than 2 GB growth over 300 s (`GATE_SWAP_GROWTH_GB`, `GATE_SWAP_WINDOW_S`) | Rapid memory exhaustion | Slow recovery while window includes burst | AUTOMATE. Use measured growth and bounded history, not a manual unhold. |
| D06 Process/worktree/tick warning thresholds | `GATE_PROCS_MAX = 2500`, `GATE_WORKTREES_MAX = 40`, `GATE_TICK_MAX_S = 900` | Early indication of leaks or stale daemon | Alert noise; no direct stop in admission | AUTOMATE. Correlate with liveness and pressure; do not silently promote warnings into gates. |
| D07 Disk hard stop | `DISK_HARD_STOP_GB = 30`; no launches, reaps continue | Filesystem exhaustion and corrupt writes | Capacity remains idle | AUTOMATE. Retain free-space protection, size reserve using measured install/worktree growth. |
| D08 Disk reuse-only job-kind gate | Below 100 GB (`DISK_REUSE_ONLY_GB`), only FIXUP/LAND/SALVAGE IDs | More checkout allocation on a filling disk | Small docs jobs blocked; name can misclassify allocation | CUT. Reserve measured bytes per job/worktree; retain D07 and protect list. |
| D09 Disk freeze/halve/yellow policy | Autopilot `lane_disk_gate`; unknown becomes yellow, freezes raises | Growth without trustworthy disk signal | Conservative pacing; external consumer dependency | AUTOMATE. Drive transitions from disk growth and known cleanup results; do not assume absent autopilot means green. |
| D10 oMLX memory cap | `min(6, memsize // 32 GiB)`; unknown gives 0; clamped even after overrides | Local-model memory overcommit | Coarse half-memory reserve and six-worker ceiling | AUTOMATE. Reserve measured model/KV memory; remove arbitrary six only after equivalent memory accounting. |
| D11 Local mid-tier cap | `LOCAL_MID_CAP`; default 1 if gate tripped, otherwise 4 below CPU load or 2 | Local inference overload | Extra cap atop lane/global limits | AUTOMATE. Use runtime occupancy and local memory evidence, preserving host stop. |
| D12 Dynamic global bounds | [concurrency.py](../../contrib/mac/concurrency.py): min 4, max 64; env `ASHLR_CONCURRENCY_MIN/MAX`; operator cap wins | Unbounded sessions | Fleet can bind at a guessed ceiling | AUTOMATE. Replace product ceiling with a measured capacity envelope; never overrun explicit operator cap. |
| D13 Legacy fleet cap 18 | Concurrency seed; exact top-level 18 is retired only on first controller startup; malformed cap falls back to 18 | Safe startup after missing/corrupt state | Temporary underuse, magic-value migration | AUTOMATE. Version the migration and validate configuration; do not present 18 as the current fixed global limit. |
| D14 Global adaptation timing | Concurrency +2/120 s, backoff x0.75 at most every 60 s, 900 s settle and incident window, 50 history entries | Oscillation and repeated overload | Slow ramp after transient trouble | AUTOMATE. Tune from headroom and observed recovery; preserve bounded incident history. |
| D15 Single tick and slot writer locks | Nonblocking `dispatchd.tick.lock`, controller `SlotWriter` lock, hard-cap clamp | Double launch and competing controllers | Contended tick exits | AUTOMATE. Keep kernel locks with holder diagnostics and crash release. |
| D16 Optional tick budget | `TICK_BUDGET_S = 90`; `over_budget()` skips optional work | Maintenance starving launches | Optional tasks may wait across ticks | AUTOMATE. Keep deadline with phase receipts and starvation reporting; no blanket timeout removal. |
| D17 Required phase deadlines | setup 10 s, budget_read 25, liveness 25, worktree_account 5, admission 10, restock 5, queue_parse 10, controller_bus 10, adapt 10, controller 10, launch 30, status 15 | Wedged Python loops, reads or children | Tick fails closed when required phase expires | AUTOMATE. Preserve monotonic deadlines and per-phase evidence; adjust against measured tails. |
| D18 Optional worktree reap deadline | `WORKTREE_REAP_BUDGET_S = 15`; exhaustion yields | Cleanup monopolizing tick | Delayed disk recovery | AUTOMATE. Resume bounded cleanup next tick with protected-data checks. |
| D19 Child/probe timeouts | `_run` group kill; health 2 s, process snapshot 5, memory 10, swap 5, daemon status 30, autopilot/API helpers 20, `_git` 30 | Orphan grandchildren and blocked supervisor | Probe may be unavailable under load | AUTOMATE. Propagate remaining phase deadline and kill/reap process groups; unknown is not success. |
| D20 Spawn/reap grace | `GRACE = 120`; recent run markers and reaping receipts | Premature duplicate retries during process transition | Stale markers occupy capacity | AUTOMATE. Prefer process identity plus bounded receipts; keep grace for uncertain transitions. |
| D21 Lane ramp and failure step-down | `RAISE_GAP = 120`, +2 ramps; Devin last 10, more than 3 non-PR outcomes, step 2, floor 6 | Failure bursts and oversubscription | Coarse non-PR quality proxy | AUTOMATE. Separate infrastructure faults, valid no-ops and task outcomes; do not punish missing evidence as observed failure. |
| D22 Graduated shed controller | [fleet_controller.py](../../contrib/mac/fleet_controller.py): factors 1/.5/.25/0; load 1.25/1.5/1.8 per CPU, free memory 25/15/8%, swap .25/.5/.75 of gate | Saturation before hard stop | Multiple overlapping tuning bands | AUTOMATE. Consolidate resource policy with D02-D14; keep independent hard backstop. |
| D23 Controller recovery and missing critical readings | 90% restore scale, +5 memory points, 120 s dwell; load/CPU/memory/procs unknown freezes | False recovery and blind admission | Slow recovery; conservative freeze | AUTOMATE. Use fresh readings and measured recovery; never substitute zero for missing telemetry. |
| D24 Controller activation switches | `FLEET_CTL_MODE` defaults shadow; enforce phases `abc`, only tightens | Unobserved new controller steering fleet | Shadow results do not relieve load | AUTOMATE. Qualify effects and digest before adoption; no docs change activates it. |
| D25 Controller quality/backpressure limits | Five samples, quality floor .75, 6 h quality/1 h merge windows; queue/free-slot ratio 3; 600 s pressure TTL; 8 MiB ledger | Bad routing from tiny samples and runaway producers | Slower restock and incomplete old history | AUTOMATE. Keep data sufficiency and expiry, tune queue pressure from service rate. |
| D26 Fleet install semaphore | [install-gate.py](../../contrib/mac/install-gate.py): one install at a time, 1800 s wait, .25 s polling; [launch shims](../../contrib/mac/launch-gate.sh) fail open | Simultaneous package-manager disk/CPU storms | Serializes independent cached installs; not universal enforcement | AUTOMATE. Admit installs by I/O budget and shared store locks, preserving bounded wait. |
| D27 Ready queue lock | `ASHLR_READY_LOCK_TIMEOUT = 10 s`; log waits over 1 s; timeout yields | Queue corruption and wedged writers | Deferred work under contention | AUTOMATE. Keep atomic writes and bounded lock acquisition. |
| D28 Fresh-launch accounting grace | 180 s since newest base/log marker, or no log yet, is treated as not finished | Reaping a just-starting worker | Stale launch markers reserve slots | AUTOMATE. Reconcile PID/attempt identity and terminal receipts; preserve uncertainty rather than publishing partial work. |
| D29 Local job-size admission | codex-local `_size_hint > 60` defers launch | Tasks exceeding local session capability | Static size proxy can strand small-context long work | AUTOMATE. Use measured context, model capability and deadline fit, with authorized rerouting for work that cannot fit. |
| D30 Diagnostic observation caps | Verified-completion 24 h horizon and max 20 detail IDs; recent publish detail max 20 | Unbounded status responses | Older or truncated detail invisible in summary | AUTOMATE. Keep bounded projections with explicit windows/truncation and durable underlying receipts. These are display limits, not execution stops. |

### slots.json and budget-overrides.json

Each lane row is a separate source-default constraint. Tuple order is
`target / floor / ceiling / hard_cap`. `clamp_lane()` clamps ceiling and target
to hard_cap, floor to ceiling; oMLX also clamps to detected memory. `tgt()` can
lower target through `effective_target`. `global_cap()` takes the minimum of
unheld lane targets and the adaptive cap. These are not additive entitlements.

| ID and constraint | Where enforced, source default | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| L01 codex-cmp lane limits | Dispatcher DEFAULT, `10 / 10 / 32 / 32` | Excess native sessions | Fixed floor/ceiling poorly match actual service rate | AUTOMATE. Size native concurrency from current capacity and host health, retaining owner ceilings. |
| L02 codex-personal lane limits | DEFAULT, `10 / 10 / 32 / 32` | Same-account overcommit | Floor can fight backoff | AUTOMATE. Separate preferred utilization from a mandatory floor. |
| L03 claude lane limits | DEFAULT, `0 / 0 / 8 / 8` | Uncommissioned subscription use | Zero target leaves capacity unused | RETHINK. Determine intended account admission; zero target is not proof of exhausted quota. |
| L04 devin lane limits | DEFAULT, `6 / 3 / 10 / 10`; autopilot floor/ceiling reapplied then hard-clamped | Hosted concurrency and allocation overload | Comments elsewhere say 10/3/16 | AUTOMATE. Generate defaults once and show effective clamp; preserve account/spend authorization. |
| L05 claude-api lane limits | DEFAULT, `4 / 0 / 8 / 8`; API helper repaces each tick | Metered credit overspend | Budget helper or scope can stop work | KEEP-HARD for spend authority. Automate pacing inside that authority; no quota-to-paid fallback. |
| L06 codex-local lane limits | DEFAULT, `6 / 0 / 6 / 6` plus local health | Local memory/decoder overcommit | Six remains an independent ceiling | AUTOMATE. Use measured serving slots and memory reservations. |
| L07 omlx lane limits | DEFAULT, `OMLX_CAP / 0 / OMLX_CAP / OMLX_CAP` | Local memory exhaustion | Hardware formula may underuse small models | AUTOMATE. Use D10 accounting and exact model readiness. |
| O01 Explicit per-lane and top-level hard caps | `slots.json`, `_cap`, `clamp_lane`, concurrency `bounds` | Overriding operator-contributed capacity | May bind below available hardware | RETHINK. Mason must distinguish intentional allocation from old seeded defaults; no automatic widening. |
| O02 Manual lane/repository holds and queue PAUSE | Dispatcher `held`, runs HOLD/PAUSE; authority holds store | Work after explicit stop | Indefinite pause absent release | KEEP-HARD for consent. Add scope/reason/expiry metadata without auto-clearing deliberate holds. |
| O03 Exhausted-credit stop | Dispatcher `credits_exhausted` sets held_by credits; supervisor clears | Paid retries without balance | Restored credit can leave lane held | AUTOMATE. Reconcile fresh account-bound balance plus authorized spend scope before release. |
| O04 Usage/rate-limit backoff | `ab_scan`, 16 KiB tail; default 6 h, bounded 24 h; only autobackoff holds auto-release | Retry storms after provider limit | Forged stdout or missing reset can cause long idle time | AUTOMATE. Prefer authenticated reset evidence; retain bounded fallback and never log provider text. |
| O05 Authentication-failure hold | `ab_auth_scan`, at least two distinct failed/EMPTY runs with anchored auth error | Repeated failing sign-in and credential churn | Requires account recovery | AUTOMATE. Reprobe value-blind identity; device approval stays with Mason. Never edit auth. |
| O06 budget-overrides stops and reserve readings | `_BUDGET_OV` to `fc.lane_quota`, budget projection; external `bin/autopilot.py` and API pacing helper | Exhausted allocation or prohibited spend | Unknown schema/host policy may hold work | RETHINK. Host file and complete autopilot are unavailable; inventory stop fields with owner-safe projection before proposing removal. Do not invent a stop percentage. |
| O07 Native account reserve policies | [routing/policy.ts](../../src/core/routing/policy.ts): balanced Claude 40% weekly reserve, 70% session ceiling; reserve mode 85%/50%; Codex disabled by default; all-in drops reserves | Consuming owner's interactive allowance | Unused expiring subscription capacity | RETHINK. These are recorded Mason choices; separate signed/explicit reserves from engine defaults. |
| O08 Unknown/stale capacity and purchased credits | [Resource evidence](../RESOURCE-EVIDENCE.md), account-bound freshness and grant scope | Mistaking history or gift/credit balance for live entitlement | Conservative routing | KEEP-HARD for financial/identity binding. Automate refresh; unknown never proves free capacity. |
| O09 Spend-down advisory expiry | Dispatcher use-it-all helper 3 s probe, `use-it-all.v1`, timestamp within 120 s | Routing from stale or malformed urgency claims | Stale projection loses tier boost | AUTOMATE. Keep advice separate from admission and spend authority; expiry never replenishes quota. |
| O10 Subscription-limit to credits exception | Dispatcher ratelimited branch ignores codex-cmp usage_limit with a continuing-on-credits event; autobackoff also treats produced work differently for that lane | Avoiding unnecessary stop on an already commissioned credit pool | Could cross a financial boundary if spending scope is absent | RETHINK. Verify separate existing account-bound credit authorization with Mason/host evidence; source log wording does not prove unauthorized spend or provide new permission. |

## Queue, routing, duplication and batch policy

| ID and constraint | Where enforced, source default | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| Q01 Queue tier enum and safe job/repo/prompt paths | Dispatcher TIERS/JID/launch validation; [queue contract](../QUEUE.md) | Silently skipped work and path injection | Invalid rows wait for repair | AUTOMATE. Validate at every producer; tiers are frontier/work/mid/fast. |
| Q02 Claim/launch serialization and attempt identity | Dispatcher locks, [launch_precheck.py](../../contrib/mac/launch_precheck.py), [bus contract](../AGENT-BUS.md) | Duplicate execution or overlap | Lease/identity bookkeeping | AUTOMATE. Claims coordinate work; they do not grant execution authority. |
| Q03 RETIRED jobs and completion receipts | Dispatcher exact IDs and router-queue read; unreadable router queue stops launches | Re-running cancelled/completed tasks | Entire tick can defer on unreadable source | AUTOMATE. Verify exact completion provenance, never infer completion from matching filenames. |
| Q04 Dependency gates | [restock.py](../../contrib/mac/restock.py): `after=`, PARKED-DEP, all dependency IDs must have MERGED evidence | Starting work on unavailable base | Queue wait through predecessor merge | AUTOMATE. Unpark mechanically and preserve Security-pin wording; do not treat dependency completion as a pin. |
| Q05 Minimum route residency | Dispatcher `route_decision`; [hysteresis](../ROUTE-HYSTERESIS.md): 3600 s; early move only auth failure or numeric zero quota | Route churn | Healthy but congested lane can hold work for an hour | CUT. Replace fixed hour with expected-finish improvement plus switching cost and fresh capacity evidence. |
| Q06 Route move count | Two moves in trailing 21600 s, including hard-down incidents | Ping-pong routing | Third failure strands unlaunched work | CUT. Use stability penalty and evidence of service failure rather than a lifetime-like incident counter. |
| Q07 Launched pool immutable and route state fail-closed | Launch receipt locks pool forever for job ID; invalid state stops tick | Double execution and misattributed usage | New attempt needs new identity | AUTOMATE. Keep immutable attempt ownership; create a fenced successor for retries, never migrate a running attempt. |
| Q08 Empty/existence prechecks | [launch_precheck.py](../../contrib/mac/launch_precheck.py): two empty finishes; 20 s precheck; code 13 parks at 1/2/4...60 min; dispatcher `PC_MAX = 8` | Repeated no-op spend and false completion | Existence heuristics delay valid repairs | AUTOMATE. Use base+task identity and verified outcomes; keep fail-open handling of unavailable evidence and no completion claims from existence alone. |
| Q09 Restock quotas and strategic mix | [restock.py](../../contrib/mac/restock.py): bold floor .30, Devin restock target 10/ceiling 16, two no-ops/24 h | Shallow queues, repetitive tasks and overly cautious work | Strategy mix and consumer defaults drift | RETHINK for mandatory bold floor; automate needs from actual throughput and shared source defaults. |
| Q10 Batch size/prompt/attempt bounds | [batcher.py](../../contrib/mac/batcher.py): min 2, default 8, max 10; 200000 chars; two attempts; 4 h wall budget | Overlarge sessions and repeated partial bundles | Bundles cannot exceed round-number policy | AUTOMATE. Fit context and measured task cost; preserve bounded time, prompt size and retry identity. |
| Q11 Batch routing exclusions and samples | Batcher subscription lanes only; release/desktop/main-repair/PR maintenance solo; three sessions before tuning; growth 1.25, shrink .7 | Spend widening and unrelated high-priority work blocked by bundle | Limits eligible work and learning speed | AUTOMATE. Keep spend scope and priority isolation; tune by measured session outcomes. |
| Q12 Reroute destinations and producer pressure | [controller](../../contrib/mac/fleet_controller.py): only codex-cmp/codex-personal/claude destinations; metered and local lanes excluded | Silent paid fallback or invalid local execution | Fewer alternative lanes | KEEP-HARD for financial/identity scope. Expand destinations only with equivalent admission, not provider-name heuristics. |
| Q13 Ready-depth and restock gate | [queue_gate.py](../../contrib/mac/queue_gate.py): target max(8, ceil(2.5 x cap)), exclude parked/retired/duplicate/invalid rows; dispatcher shallow threshold 3 x max(free slots, 4), restock child 4 s | Excess producer work and queue flood | Multiple depth proxies and older lane enum can miscount demand | AUTOMATE. Use service-rate/WIP budget and shared lane schema; preserve eligibility and no execution from malformed rows. |
| Q14 One repair/drain per target | Dispatcher `fix_main_repos` and `drain_targets` defer matching launches | Concurrent main repair or PR writers | A slow repair delays another attempt | AUTOMATE. Keep fenced target ownership, terminal reconciliation and successor attempts. |
| Q15 Restock and batch kill switches | `queue/RESTOCK_OFF`, `queue/BATCH_OFF`; batch launcher must exist | Unwanted producer activity or uncommissioned batch execution | Capacity may remain unbatched/unstocked | RETHINK. Owner stop is binding; add reason and health evidence without clearing switches from task code. |
| Q16 Task/lane/model fit restrictions | Dispatcher tier lookup in `models.json`, `batch_sessions.devin_route` and host-owned batch config | Unsupported model work or hosted task using wrong account/product | Fallback lanes may be unavailable | AUTOMATE capability/size/commissioning checks. Keep financial scope; source configuration is not proof a hosted session is free. |

## Publication and release controls

P01-P09 refer to the [publisher mirror](../../contrib/mac/publish.sh). These
describe source enforcement, not authorization to invoke it in this job.

| ID and constraint | Where enforced or specified | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| P01 Trusted Git environment and dependency-link check | Fixed Git config/credential helper, redirects/headers reset, dependency directory/index validation | Hooks, helper substitution and accidental dependency publication | Additional validation and constrained Git use | KEEP-HARD. Preserve provenance and credential destination checks. |
| P02 Secret-shape pre-push checks | `scrub.pl --check --allow-fixtures` for diff; stricter notes check; failure aborts | Secrets leaving in code or PR body | Scan and fixture handling | KEEP-HARD. Extend shared corpus and egress coverage, never exempt arbitrary fixtures or notes. |
| P03 Workflow classifier category 3 | New secrets refs/inheritance, id-token, privileged triggers, unpinned actions; opaque/binary/symlink/type/escape guards | CI credential exfiltration and classifier evasion | Narrow Security review wait | KEEP-HARD. Parsing uncertainty fails closed; do not broaden auto-pass. |
| P04 One-shot G1 pass | Owner/mode 0600/non-symlink pass; exact job, tree and parent SHA; consumed after push | Reusing review for a changed candidate | Re-review after tree changes | AUTOMATE. Mechanically mint/verify digest-bound evidence through Security custody; approval cannot be supplied by task arguments. |
| P05 Sensitive path handling | SRE regex; secret/sandbox/auth/wrapper paths skip auto-merge; `.npmrc` denied | Altering the publisher's trust boundary | Security handoff | KEEP-HARD for credential/control changes. Pin-scope differences go to R02. |
| P06 Broad protected-directory drift reset | `.envrc`, `.vscode`, `.husky` reset/clean; `.github` removed from drift set after successful G1 classification | Task-created execution hooks | Can discard legitimate editor/hook work | RETHINK. Keep execution-boundary validation, decide whether nondestructive refusal can replace reset/clean. |
| P07 Optional full test suite in publisher | `PUBLISH_FULL_TESTS=1` opts in; default off; optional run alarm 1500 s with temp HOME and scrubbed output | Unverified publication | Duplicates worker/CI checks when enabled | CUT the routine repeated full suite. Existing source already defaults off; keep touched checks and exact-candidate required CI. |
| P08 Fresh-context judge option | `PUBLISH_JUDGE_CMD`, nonconfident outcome leaves auto-merge unarmed; unset means off | Mismatch with done contract | Extra model call and leader wait | AUTOMATE. Use deterministic done-contract evidence where possible; keep security review distinct from model confidence. |
| P09 Integrated original-PR proof and uncertain push/merge reconciliation | Exact original PR/head/base proof, 30 s GitHub calls, consumed receipt; no repeated push on uncertain result | Duplicate merges or wrong PR attribution | Extra API observations | AUTOMATE. Preserve fenced intent and fresh provider reconciliation. |
| P10 PUBLISH_HOLD backlog stop | Dispatcher reap loop skips publish; checks seven repo queued counts every 600 s, releases below 50 | Actions backlog growth | Finished work stranded across repos; unrelated API failure keeps hold | CUT. Limit CI work at the constrained service, keep durable finished results and bounded publication queues. Host state remains unknown. |
| P11 Sanctioned release workflow and source/artifact binding | AGENTS; [releasing](../RELEASING.md), [M523](../contracts/CONTRACT-M523.md) | Wrong or unsigned bytes reaching users | Attestation and artifact verification | KEEP-HARD. Agents may dispatch authorized workflows; evidence must bind source, publication run and assets. |
| P12 Stable release recovery holds | AGENTS M523: Security-reviewed finalizer before enabling workflow 350636007; leave empty v3.30.8 unchanged | Tag mutation and claiming unproven updater recovery | Affected release waits for qualified repair | KEEP-HARD for publication integrity. Exact current release/workflow status is unverified, not assumed recovered. |
| P13 Extra release human clicks | [release autonomy](../RELEASE-AUTONOMY.md), source inventory of settings and dispatch | Historically manual sequencing | Workflow dispatch/enable waits | AUTOMATE within commissioned authority using durable intents and status reconciliation. Missing evidence never proves a gate absent. |
| P14 PUBLISH_LANDONLY priority/allowlist hold | Dispatcher `_bucket > 3` deferred unless fixed RQ-DESK prefix, listed job or G1 pass | New work overwhelming deliberate landing priority | Completed lower-priority work waits indefinitely | RETHINK. Owner switch intent is unknown; retain explicit hold, replace incidental name-based priority with a scoped policy after decision. |
| P15 Phantom open-PR cutoff | Dispatcher `PH_DRIP_MAX = 400`; only LAND/FIXUP/CONSOLIDATE/CLOSE/PHX kinds pass; count cached 600 s; unavailable count filters | Unbounded open-PR inventory | Unrelated finished feature/docs work stranded; API outage acts like high count | CUT the absolute PR-count/name proxy. Use measured review/merge throughput and durable WIP scheduling. |
| P16 PUBLISH_DRIP fixed rate/queue stop | Dispatcher switch enables at most 10 publishes/300 s; file queued count at least 150 gives zero budget | Actions stall and publication bursts | Stale count or fixed rate underutilizes recovered CI | CUT fixed thresholds in favor of service-aware admission with fresh readings and bounded rate. Explicit owner pause still binds. |
| P17 Single active publisher/reap handoff | Dispatcher `publish_busy` plus recent reaping receipts, wait until reap-one completes auto-merge handoff | Out-of-order merge-queue admission and duplicate publication | Serial PR creation even across independent targets | AUTOMATE. Preserve per-target order and uncertain-result reconciliation; qualify any safe cross-target concurrency separately. |
| P18 Keep aborted/secret-shaped worktree | Dispatcher keep.txt and non-PR/non-empty result; secret-shape abort retained for supervisor | Retrying a suspected leak or deleting evidence | Disk use and manual investigation | KEEP-HARD for fail-closed egress. Diagnose counts and paths without echoing offending content; preserve owner data. |

## Signed authority and merge promotion

Source: [grant types and ceilings](../../src/core/authority/types.ts),
[standing-grant verification](../../src/core/authority/standing-grant.ts),
[clamp](../../src/core/authority/clamp.ts), [rollout](../../src/core/authority/rollout.ts),
[G0-G7](../../src/core/fleet/merge-gates.ts). The older signed-grant product is
still enforced in code even where newer fleet doctrine calls for less friction.

| ID and constraint | Where enforced, source default | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| A01 Signed identity, scope and anti-replay | Compiled ES256 roots, exact canonical schema, machine binding, sequence floors and revocation | Forged or cross-account authorization | Signing/custody integration | KEEP-HARD. No config or prompt may widen a signature's scope. |
| A02 Grant expiry and code binding | At most 30 days, issue time at most 5 min ahead; authority surface digest mismatch pauses | Stale consent and altered trusted code | Reapproval after authority code changes | RETHINK. Narrow reapproval to effect/custody changes with machine-verifiable compatibility, while preserving signatures and revocation. |
| A03 Legacy file/line caps | G2: marker-absent 10 files/300 lines, local-authored or local-enforced 4/150; explicit `operator-signed` volume can exceed | Proxy for reviewable blast radius | Artificial slicing, repeated context and PRs | CUT the legacy volume policy through an authorized migration. Retain semantic risk checks, tests and signed scope; never rewrite an existing signature. |
| A04 Daily merge count caps | G0 rolling 24 h: legacy 24/repo, local-enforced 4; signed volume can choose no cap via safe-integer sentinel | Historical throughput proxy for blast radius | Green work waits until count ages out | CUT the throughput proxy. Use verification/service capacity; preserve explicit owner allocations until changed legitimately. |
| A05 Risk class ceiling | G2 medium maximum; local-authored/local-enforced low | Unchecked dangerous effects | Model/risk-label false positives | AUTOMATE. Classify protected effects and evidence requirements rather than relying solely on subjective risk labels. |
| A06 Clamp intersection and off states | min(grant, stage, switch, config, ceilings); cached 10 s, stop/switch reread; config only tightens | Unilateral escalation | Hard to explain effective policy | AUTOMATE. Expose exact binding input and reason; keep scope intersection. |
| A07 Rollout time/sample ladder | Signed shadow through 3d; 5 would-merges/12 h, 3 merges/8 h, 10/24 h, 25/48 h and later 5-merge/24 h criteria; one-stage advance/drop | Untested fleet expansion | Multi-day waiting even with deterministic evidence | RETHINK. Mason can choose signed `elite-direct`; replace elapsed-time proxies only with an approved evidence-based grant model. |
| A08 Preferred judge wait | G6 `JUDGE_PREFERENCE_WAIT_MS = 24 h` | Preferred reviewer-family availability | Day-long queue despite another qualified judge | CUT. Dispatch an available independent qualified reviewer immediately, retaining attestation and scope checks. |
| A09 Judge verdict age and independence | Verdict usable 24 h, diff hash bound; family eligibility, two judges for specified producers; elite-direct exact allowlist exception | Stale, self-authored or substituted approval | Extra calls and model-specific policy | AUTOMATE. Exact-candidate deterministic evidence where sufficient; retain independent Security review and provenance. Do not expand elite status from an unverified model label. |
| A10 Pending-check age limit | G7 `CHECKS_MAX_PENDING_MS = 24 h` | Indefinite waiting on wedged required checks | Marks long queue delays as failure | AUTOMATE. Detect cancelled/missing/stale runs and repair workflow state; never count timeout as passing. |
| A11 G1 protected-path owner lane | `protectedPathHits`, broad authority/import-closure protected set | Agent changing its own authority | Review wait extends beyond actual secret boundary | RETHINK. Reduce broad protected scope to real effect/custody boundary with independent coverage; current security pins remain. |
| A12 G1b no test tampering | Removed assertions, focused/skipped tests and snapshots checked | Manufacturing a green result | Legitimate test maintenance can require explanation | AUTOMATE. Keep regression evidence and explicit quarantine rules; never weaken checks to pass this task. |
| A13 G3 exact-tree verification | Trusted verify command, current base, tree/hash/path checks | Test evidence for different bytes | Reverification after meaningful input change | AUTOMATE. Reuse only exact-input verified receipts, invalidate on affected changes. |
| A14 G4 report/diff consistency and G5 blast-radius checks | Claims verification, configured deterministic/spec/red-team checks | Unsupported success claims and missed effects | More parsing/check execution | AUTOMATE. Bind receipts to observed diff and behavior; use human review only at retained irreversible boundaries. |
| A15 G7 required checks and App identity | Required checks plus host-verified `ashlr/verify`, SHA-pinned merge; partition of observed checks | Spoofed success or unprotected server enforcement | CI wait and API calls | AUTOMATE. Preserve exact-head required checks; remove unrelated advisory work from blocking set only through normal configuration. |
| A16 Per-pass review/verify budgets | [automerge-pass.ts](../../src/core/fleet/automerge-pass.ts): judge default 8, verifyBeforeJudge defaults to it; fanout replay max 16 | Frontier-call cost and tick monopolization | Unmetered deterministic verification also queues | AUTOMATE. Separate paid review budget from host/time-limited verification; no extra spend authority. |
| A17 Class-B veto window | Signed 30 min minimum to 24 h maximum; [Leader](../LEADER.md) class policy | Unwanted prospective policy effects | Fixed delay on reversible operations | RETHINK. Mason selects which effects still need a veto window; use immediate scoped execution for already-authorized reversible work. |
| A18 Parser/representation ceilings | Grant max 32 repos, 8 stages, 64 seats, 3 roles/seat, 30-day stage hours, $10000/day representational ceiling | Malformed or unbounded payloads | Large fleets need schema evolution | AUTOMATE. Keep bounded validation, distinguish parser limits from granted spend or throughput. |
| A19 Ledger integrity and write-before-act | Hash chain, sequence, head anchor/high-water marks; broken ledger sticky until recovery grant | Tampering, replay and unrecorded privileged effects | Storage failure halts actions | KEEP-HARD. Preserve durable audit and anti-replay; recovery cannot erase sequence floors. |
| A20 Self-improvement promotion's all-green metric gate | Constitution self-improvement loop; `improve/*`/`ashlr-cloud/*`, exact-head reproducible improvement, no gate/metric self-edit | Reward hacking and false improvement | Specialized proposals wait on all reported checks | AUTOMATE. Keep reproducible measurement and self-protection; reconcile all-check wording with affected-only doctrine in R03. |

## CI, verification and runtime timeouts

| ID and constraint | Where enforced or specified | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| V01 Merge queue required checks | [ci.yml](../../.github/workflows/ci.yml): Merge Gate, Classify changes, Quick typecheck, secret scan on PR/merge_group | Untested merge candidate and secret leak | Queue and affected-check duration | AUTOMATE. Preserve required checks and merge-group execution. Hosted ruleset settings are unknown. |
| V02 Full per-PR CI and manual merge wait | Constitution Article 9 cuts them; current workflow fast path exists; older AGENTS wording still mentions full Merge Gate | Historical confidence proxy | Redundant minutes/compute and human delay | CUT residual policy requiring unrelated full suites on every PR. Keep affected checks, scheduled full CI and fix-forward work. |
| V03 Tier-1 import closure and CODEOWNERS drift | AGENTS; quick typecheck authority checks even on docs changes | Indirect expansion of privileged code | Regeneration/review complexity | AUTOMATE. Keep generated closure evidence and named Tier-1 roots; snapshot regeneration remains Mason-only where specified. |
| V04 Local changed-file verifier | [verify-changed.mjs](../../scripts/verify-changed.mjs), once foreground, unchanged tree skips; three concurrent typecheck slots by default | Duplicate expensive checks | Shared slot wait | AUTOMATE. Reuse exact-input results; docs-only work still runs requested checks. |
| V05 Docs and affected tests | [package.json](../../package.json), `check:docs`; hermetic runner with temp HOME | Broken navigation and regressions | Focused local runtime | AUTOMATE. Link-check this ledger explicitly because operator entrypoints are not recursively audited. |
| V06 Quarantine expiry and no focused tests | [quarantine rules](../QUARANTINE-LEDGER.md): tracked live skip, owner, at most 7 days, `.only` forbidden | Hidden/permanent test loss | Ledger maintenance | AUTOMATE. Machine-enforce expiry; secret-shape/gitleaks/cargo-deny/ci-gate cannot be quarantined. |
| V07 Hosted job and release timeouts | ci.yml per-job `timeout-minutes`, release-smoke phase/step bounds | Hung CI spending and stalled release | Cold builds may time out | AUTOMATE. Tune by measured job tails, retain absolute deadlines and cancellation. |
| V08 Resident daemon phase bounds | [phase contract](../daemon-tick-phases.md): per-phase deadline/AbortSignal; frontier resolution 30 s; denial watcher ready/barrier 3 s each | One wedged await freezing daemon | Degraded phase output | AUTOMATE. Keep bounded waits, propagation and phase ledger; missing client is skipped, not invented. |
| V09 Mirror freshness/deadlines | [lane freshness](../FLEET-LANE-FRESHNESS.md): observations each minute, per-repo prep deadline 3 min | Dispatching from stale/unready source | Prep can defer work | AUTOMATE. Validate source identity/freshness; measure checkout latency rather than bypass readiness. |
| V10 Fix forward and release-qualified SHA | Constitution Article 9; scheduled full CI and release handoff | Propagating regressions into releases | Repair work interrupts roadmap | AUTOMATE. Queue bounded forward fixes and require release evidence for candidate SHA; this grants no rollback or tag-move authority. |

## OS, desktop, gateway and connector boundaries

| ID and constraint | Where enforced or specified | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| T01 OS confinement and self-test | [sandbox policy](../../src/core/sandbox/policy.ts), [confinement](../../src/core/sandbox/confine.ts), standing authority | Task escape, auth reads and unrelated file writes | Platform setup and scoped mounts | KEEP-HARD. Successful probe required where autonomous confinement is mandatory. |
| T02 Full lane sandbox denies and SB-17 IPC | Host `.sb` profiles; checked-in fragment denies LaunchServices Mach lookup and AppleEvent sends | App-launch/AppleScript escape despite binary deny | Agents must use sanctioned adapters | KEEP-HARD. Full live profile unverified; fragment is not a profile replacement. |
| T03 TCC Accessibility/Screen Recording grants | [desktop operator](../DESKTOP-OPERATOR.md), [operator policy](../../src/core/desktop/operator-policy.ts) | Reading/control without OS consent | Mason/device setup | KEEP-HARD. Report missing grants; never prompt around or mutate TCC. |
| T04 Desktopctl disabled/default capability level | [DESKTOPCTL](../DESKTOPCTL.md): enabled flag, full grant for run; browser mode read-only | Unauthorized desktop control | Setup and capability checks | KEEP-HARD for consent; automate capability diagnosis without activation. |
| T05 App allowlist and unsaved quit hold | [Apps control](../APPS-CONTROL.md): empty allowlist, logged actions, unsaved work exit 3 | Closing unrelated apps or destroying unsaved data | Owner enrollment/needs-you | KEEP-HARD for data/consent. Improve app-state evidence; do not auto-discard. |
| T06 Desktop action intent/log/KILL gates | Desktop operator focus/scroll/type/click intent then act; comms pause blocks writes | Unlogged/unconsented OS actions | Extra durable append | AUTOMATE. Preserve pre-action intent and bounded reconciliation, not repeated approval for granted actions. |
| T07 Desktop request bounds | operator `MAX_SCROLL = 50`, helper/transport bounded requests | Runaway input and oversized operations | Large operations need chunks | AUTOMATE. Chunk with scoped stop checks; keep parser/runtime limits. |
| T08 Loopback console tokens and remote exposure | [app drive](../APP-DRIVE.md), [remote gateway policy](../../src/core/web/remote-gateway-policy.ts) | Local or remote caller impersonation | Token custody and request validation | KEEP-HARD. Read/mutation scopes, origin/audience checks and no token logging remain. |
| T09 MCP gateway allow/deny/approval policy | [mcp-gateway-policy.ts](../../src/core/mcp-gateway-policy.ts): host identity, exact tools, allow > approval > deny; unknown writes subject to fleet switch | Unscoped companion mutations | Approval-required calls remain blocked | AUTOMATE scoped policies; RETHINK broad ask-before-every-change for already-authorized reversible tools. No request argument can approve itself. |
| T10 Gateway session revocation and retention | [agent gateway guide](../AGENT-MCP-CLI.md): missing session revoked; arguments redacted; 14-day activity retention | Continuing revoked sessions and argument leaks | Session restart and bounded history | KEEP-HARD for revocation/privacy; automate expiration and counts-only diagnostics. |
| T11 Connector run denied pending Security | [connector profile](../CONNECTORS.md): metadata only; no scope/credential resolution for denied run | Unreviewed process activation with account access | Integrations remain unusable | RETHINK. Commission a mechanically scoped executor under Security review; profile presence is not execution authority. |
| T12 Connector URL/schema/import restrictions | Connector validator: HTTPS except loopback, no userinfo/query/fragment, unknown fields/secret shapes refused; explicit lane-owned CODEX_HOME; inline credentials withheld | Credential leakage and cross-lane identity | Manual migration of unsupported credential entries | KEEP-HARD for custody/isolation. Automate metadata-only import without values or `~/.codex` access. |
| T13 Team enrollment, Locus identity and roles | [team policy](../TEAM.md), toolchain: invite/join/remove human terminal, agent access requests; agents cannot pin identity | Membership as accidental credential/scope grant | Owner access ceremony | KEEP-HARD for identity/scope. Automate request and status, never treat invitation as credentials. |

## Drafts, owner thread and outbound actions

| ID and constraint | Where enforced, source default | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| C01 Draft-first outside verified owner channel | [cos/drafts.ts](../../src/core/cos/drafts.ts), [DRAFTS](../DRAFTS.md) | Accidental external sends | Separate owner review | KEEP-HARD. Approval records a decision and does not itself send. |
| C02 Draft content/digest/storage checks | One recipient, 300-char fields, 64 KiB body, digest identity, secret refusal, private store and non-symlink dir | Approval substitution, credential leaks and malformed recipients | Oversized replies need editing | AUTOMATE validation; KEEP-HARD content/recipient binding at any eventual sender. |
| C03 Comms standing transport/recipient approval | [COMMS-AGENT](../COMMS-AGENT.md): fixed account-home file, owner/mode 0600/no-follow; unknown recipient drafts | Impersonation by relocated HOME or recipient injection | Setup once per intended scope | KEEP-HARD. Reuse standing scope mechanically, never create it from a model instruction. |
| C04 Send KILL/pause and durable log | Comms dispatch rereads account-home switches; log handles only | Sends after stop and unaccounted delivery | Storage dependency | KEEP-HARD. Reconcile uncertain delivery before retry; no duplicate-send fallback. |
| C05 Portable profile daily cap/per-message approval | [checkSend](../../src/core/agents/send-policy.ts): invalid counts deny; cap/incomplete limits draft; final branch always drafts pending verified-self evidence | Portable metadata pretending to authorize transport | Even permissive profile cannot send | AUTOMATE verified-self admission; RETHINK explicit per-message/daily policies only with owner. Never turn final draft into allow from profile alone. |
| C06 Owner intake and teammate separation | [IMESSAGE](../IMESSAGE.md): owner allowlist, readonly chat DB, ten-minute word dedup; hashed teammate sender | Private owner text exposure and teammate authority escalation | Duplicate legitimate asks may collapse | KEEP-HARD identity/audience; AUTOMATE dedup with source receipt and explicit task identity. No message bodies or handles in this audit. |
| C07 Findings bridge bounds and trust | iMessage findings: seven-day bus TTL, bounded serialized batches, untrusted `note`, no execution authority | Stale findings becoming new work or command injection | Old/oversized findings refused | AUTOMATE. Preserve original age, durable rowid dedup and untrusted classification. |
| C08 Chief-of-staff result draft digest | AGENTS; [COS](../COS.md): queue done drafts reply, explicit displayed-digest approval for outbound result | Treating job completion as send authority | Approval waits for actual external send | KEEP-HARD for external send. Wiring scope is separate from sending authorization. |
| C09 Brief scheduling/send cap | [briefs](../BRIEF-SEND.md): 07:30/22:30 ET, dry-run default, one send per channel/slot/day, needs-you max 5, message max 1200 chars | Duplicate notification and owner overload | Urgent items may await another slot | AUTOMATE. Keep idempotency, permit explicitly authorized urgent owner alerts via the established owner transport. |

## Other bounded policies found beside the inventory

| ID and constraint | Where enforced or specified | Protects against | Cost | Verdict and next action |
| --- | --- | --- | --- | --- |
| X01 Live machinery install prohibition | AGENTS; [manifest/sync](../../fleet/manifest.json), [migration](../MACHINERY-MIGRATION.md) | Replacing pinned production gate with source candidate | Separate adoption after review | KEEP-HARD for pinned boundary. Managed class does not waive dispatcher/restock Security handoff. |
| X02 Disk maintenance protected and opt-in classes | [DISK-MAINT](../DISK-MAINT.md): auth/model/Docker/client/Documents/Git protect list; gated venvs/hub-claude; dry-run default | Destructive cleanup of owner assets | Rebuildable leftovers persist | KEEP-HARD protect list; AUTOMATE proven-rebuildable cleanup within authorized scope. |
| X03 Router/node owner scope and fencing | [NODE-ROUTER](../NODE-ROUTER.md), [NODES](../NODES.md): leases, owner visibility, backup witness, promotion after 15 min | Cross-owner execution and split brain | Heartbeat/promotion latency | AUTOMATE. Keep fencing and local auth; tune failover from measured failures. |
| X04 Research admission/dedup/apply boundary | [RESEARCH-LOOP](../RESEARCH-LOOP.md): score, queue/shipped dedup, admission lint, dry-run then reviewed apply | Untrusted research manufacturing unauthorized work | Proposal-to-queue delay | AUTOMATE reversible queue admission inside granted scope; retain protected-effect lint and no implicit send/spend. |
| X05 Radar fetch caps | [RADAR](../RADAR.md): GET-only, no credentials/redirects, 15 s/2 MiB, six-hour/source floor | SSRF, unbounded downloads and source hammering | Delayed upstream discovery | AUTOMATE. Keep network/security bounds, use conditional fetch and measured backoff for cadence. |
| X06 Repo ranking cadence | [REPO-RANK](../REPO-RANK.md): at most daily, recompute same ceiling; proposals cannot enroll | Ranking churn and surprise scope expansion | Stale prioritization | CUT fixed daily recompute prohibition for offline evidence changes; retain explicit repo enrollment. |
| X07 Learned metadata and channels default-off | [SKILLS](../SKILLS.md), [CHANNELS](../CHANNELS.md): scrubbed/capped counts or unknown, configuration not credentials | Private payload leak and implicit transport enablement | Missing evidence cannot show counts | AUTOMATE metadata capture; KEEP-HARD transport/custody separation. |
| X08 Scheduled automation import disabled and deduped | [automations](../VERSE.md#automations-315): dry-run, skip existing names, schedule restrictions, imported routines disabled | Surprise repeated actions and duplicated work | Explicit activation after import | AUTOMATE eligibility/dedup, preserve owner authority for recurring irreversible effects. |
| X09 Small PR/single-writer convention | AGENTS; constitution principles | Conflicting edits and unclear review | Forced slicing when interpreted numerically | AUTOMATE claim ownership and dependency isolation; keep one concern, cut arbitrary file/line proxy through A03. |
| X10 Ranking evidence and scheduling-share floor | [repo ranking](../REPO-RANK.md): 30 snapshots, 14-day evidence, two matching PRs for proposal, default .5/.25/.25 weights, top repo at least 40% | Noisy or seedless prioritization | Floor can dominate current eligible demand | AUTOMATE evidence/windows; RETHINK mandatory share floor as an owner strategy choice. Ranking never enrolls repos or overrides eligibility. |

## Policy conflicts and Mason decisions

These are the explicit RETHINK queue. No answer is assumed and no question blocks
this documentation deliverable. Each decision should produce a versioned policy
change or a scoped owner instruction, not a private side-channel exception.

| Entry | Decision needed from Mason | Why this cannot be inferred | Safe implementation path |
| --- | --- | --- | --- |
| R01 Named issue holds (S16) | Keep or release each listed issue | Owner intent and live issue evidence unavailable | Record issue-specific release in canonical policy before work resumes |
| R02 GATES v3/v4 pin scope (S09-S12, P05, X01) | Canonical minimal trusted surface, including leader prompts/plists and live dispatcher wrappers | AGENTS keeps them; publisher comments say v4 cut some; manifest still pins broader machinery | Reconcile documentation, classifier, manifest and Security custody in a separately reviewed change; retain present pins meanwhile |
| R03 Constitution vs effective merge/grant policy (A02-A04, A07, A11, A17, A20, V02) | How Article 9 affects signed grants, rollout, veto, broad owner-lane waits and all-check self-improvement | New doctrine cannot rewrite signed bytes or remove required server checks | Signed compatibility/migration design; use existing operator-signed volume and elite-direct only when legitimately granted |
| R04 Owner resource allocation (L03, O01, O06-O07, O10) | Which caps, reserves, zero targets and stops are intentional; whether credit fallback has separate authority | Both live config files inaccessible; static defaults and comments disagree; continuing-on-credits is not proof of permission | Produce value-blind projection of binding source, value, owner and expiry; distinguish subscription allowance from paid credits |
| R05 Send/desktop recurring scopes (C05, C08-C09, T04-T05) | Which recipients, transports and apps have standing authorization; which still need per-action consent | A portable profile, queue result or available adapter proves no send/OS authority | Keep scoped grants and drafts; mechanical reuse only inside actual authorization |
| R06 Protected-directory drift cleanup (P06) | Replace destructive reset/clean with refusal plus recovery evidence | Security protection and owner-data destruction meet at this boundary | Preserve candidate for review; validate executable hooks before any sanctioned publication |
| R07 Article 2 entries | Supply canonical Article 2 text, version and location | Checkout constitution version 6 contains Articles 1 and 9 only; [prior research](../research/RQ-OSS-AGGREGATE-1.md) records same gap | IDs S/D/L/O/Q/P/A/V/T/C/X/R provide explicit entries for later mapping. They are **not** asserted to satisfy unseen Article 2 |
| R08 Strategy and integration holds (Q09, T09, T11) | Keep mandatory bold mix, broad per-change gateway approvals and connector-run commissioning hold, or replace with scoped enforcement | Explicit product/owner choices and Security commissioning cannot be inferred from model capability | Review mechanical eligibility proposal; no activation, identity pin or new spend as part of this ledger |

## Follow-up acceptance and measurement

Implement one concern per follow-up. Before a cut, capture its binding reason and
candidate identity without secret values. Replace a proxy only when the retained
invariant has an executable check; replay saturation, stale/missing evidence,
auth failure, uncertain provider result, duplicate attempt and owner-stop cases.
Never use a local model's confidence as a replacement for secret, spend or
audience enforcement. Purely reversible policy simplification may use fast
affected checks and agent repair; pinned-file changes still require Security's
reviewed digest and sanctioned adoption.

Measure queue-to-launch p50/p95, idle slots while demand is ready, publish wait,
route moves and duplicate launches, exact-tree check reuse, host pressure/fork
errors, verified forward-fix rate and scheduled full-CI failures. Report
unmeasured fields as unknown. Cut success means less measured waiting with no
weaker invariant, rather than a larger configured number. The prioritized ten
proposals and this change's verification evidence are handed off in the root
`BRIDGE_NOTES.md`; no queue, grant or runtime change is included here.
