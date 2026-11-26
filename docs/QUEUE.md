# Shared capability-routed work market

Jobs describe required capabilities and desired impact. They enter one shared
market. The dispatcher selects an available executor at claim time, using the
job's requirements, provider availability and measured outcomes. A lane or pool
on an older job is a preferred-lane hint. An absent or unknown hint leaves the
job open to every eligible executor. An explicit local executor remains local.

This is the source candidate in `contrib/mac/dispatchd.py`, supported by
`contrib/mac/work_market.py`. Live adoption requires Security review and re-pin,
then the sanctioned `contrib/mac/install.sh` path. Agents never install over
`~/.ashlr-runs/bin`. Publication remains fork-only through `publish.sh`.

## Recover a pushed job without a PR

Run `phm fleet republish --dry-run --json` (omit `--json` for one plain line per job).
It reads `~/.ashlr-runs/<job>.publish`, or `--runs-dir <dir>`, and checks public GitHub evidence.
Only an abort after the push marker, an exact surviving fork branch, and no open or merged PR
produce a READY proposal to cherry-pick the observed SHA onto fresh `master`. Nothing is queued or written.
JSON uses `fleet.republish.v1`; each job has `status`, `reason`, `head`, `sha`, `readyLine`, and `pr_state`
(`none`, `open`, `merged`, `closed`, or `unknown` when the PR lookup is unavailable).
Exit codes: 0 complete, 1 unknown evidence, 2 bad usage. Missing push links, unreadable/oversized
logs, private repositories, API failures and incomplete PR pages stay unknown. Logs are capped at 2 MiB.
This preview cannot establish cherry-pick compatibility or find recovery PRs under another head.

For the common case — the push landed but `gh pr create` never ran — the fleet finishes it
directly instead of re-running the job: `phm publish sweep` scans the local `<job>.publish`
logs for a confirmed push with no `RESULT PR` afterwards and, with `--apply`, opens the PR
through the same live checks as `phm publish resume` — but never arms auto-merge, because the
log cannot prove the branch is safe to arm; the merge queue's own gated path decides, exactly
as it does for every other PR. At most `--limit` (default 3, max 10) per pass, oldest first,
48-hour window, with `queue/publish-resume.json` remembering terminal and deferred outcomes.
`default-fetch` aborts stay with the planner-tick recovery-job requeue and
`integrated-receipt-consume` with the integrated-mode journal; both are reported under
`skipped`, never resumed. A dry run scans and reports only. The fleet self-tick runs the
same sweep inside every planner-tick pass (an applied tick resumes; a dry tick only scans).

## Job requirements

The live producer input is `queue/router-queue.md`. For example:

```text
- READY RQ-MARKET (P0, repo=phantom, tier=frontier, needs=git|gh|node, min_tier=work, max_cost_class=included, exclusive=true, impact=90): Implement the shared work market. Acceptance: routing tests pass.
- READY RQ-CLI (P1, repo=phantom, tier=work, preferred_lane=claude, needs=claude-cli|secrets:EXAMPLE_HANDLE): Complete the CLI integration.
```

`needs` is a list of capability names, including `git`, `gh`, `node`,
`codex-cli`, `claude-cli`, `browser`, or `secrets:NAME`. A secret capability is
only a host-advertised reference name. It never resolves credentials and grants
no new access. Missing required capabilities exclude a lane. Explicit CLI needs
stay binding even when the preferred executor is full. `min_tier` and `tier`
use `fast`, `mid`, `work`, `frontier`; a requested execution tier below its
minimum stays unrunnable. `max_cost_class` is `local`, `included`, or `metered`.
The ordering is a budget constraint, not a dollar estimate or spending authority.
`max_tier` is a tier ceiling: a row whose `tier` is above it is never runnable,
and spare-capacity upgrades stop at it. `data_class` is `public`, `internal`,
`confidential`, or `restricted`; only an executor cleared for that class or a
higher one may take the job. A job without `data_class` is unclassified and
keeps the earlier behavior. `work_class` is `bulk`, `standard`, or `judgment`.
It ranks resources and never excludes one. When absent it is derived: `frontier`
tier or `P0` is judgment, `fast` and `mid` are bulk, the rest is standard. The
row's repo column is the job's repo; a `repo` key in the requirements may only
restate it.
`exclusive=true` keeps a job out of combined agent sessions. It does not stop
unrelated workers. Priority (`P0` before `P1`, etc.) precedes descending numeric
impact. Existing repair, repository, size and use-it-all preferences break ties;
rebase work cannot jump ahead of a higher-priority runnable job.

`pool=` and `lane=` remain accepted hints; `preferred_lane=` takes precedence.
Restock retains legacy lane hints in the third TSV column for older readers and
carries the original requirements in a sixth JSON column. It never replaces an
unknown original hint with a hard executor constraint. Existing five-column
rows work unchanged. The full wire shape is:

```text
job<TAB>repo<TAB>lane-hint-or-empty<TAB>tier<TAB>prompt-path<TAB>requirements-json
```

For example, the sixth column can be:

```json
{"preferred_lane":null,"needs":["git","gh","node"],"min_tier":"work","max_tier":"frontier","max_cost_class":"included","data_class":"internal","work_class":"judgment","priority":"P0","impact":90,"exclusive":true}
```

Invalid requirement objects remain queued with `invalid_requirements`; they
never fall back to unrestricted execution. Prompt paths, retired jobs,
dependencies, prechecks, active worktrees, batch leases and the tick lock retain
their existing checks. Producers count lane-neutral and unknown-hint rows toward
the same global queue capacity, preventing over-admission.

## Executor admission and selection

Host-owned `queue/slots.json` supplies targets, bounds, holds, quota and optional
`capabilities`, `tiers`, `cost_class`, `repos`, `data_class`, `posture`, and
`free_until`. Existing executor contracts default to
`git`, `gh`, `node` and their own CLI where supported. Browser and secret names
must be advertised explicitly. Local models require explicit local selection,
loopback health and the existing size and concurrency checks.

Additional host-installed executors can join without another lane constant.
Their slots entry must set `executor_ready:true`, advertise `capabilities`, and
supply nonnegative integer `target`, `ceiling`, and `hard_cap` bounds. This is an
advertisement of an already installed launcher, not an installation or auth flow.
New executors also need explicit `tiers` and `cost_class`; unknown tier or cost
evidence excludes them. Advertise only supported `tiers`. Targets and operator
bounds remain enforced; no new fixed market concurrency limit is introduced.

`repos` is an allowlist of repository names the executor serves; absent means
every repo. `data_class` is the executor's clearance. Without it, the remote
built-in executors are cleared for `internal`, on-host models for `restricted`,
and any other advertised executor for `public` only. Malformed values fail
closed (no repos, `public`).

The market rejects capability, tier, tier-ceiling, repo, data-class and cost
mismatches, holds, auth failures,
exhausted quota, provider backoff, unhealthy local endpoints and saturated lanes.
It checks `models.json` tier availability, the fleet controller's budget quota
projection, and the effective targets after load shedding. Capacity is checked
again for every candidate so several jobs cannot reserve the same final slot.
The existing admission gate remains the authority for host load, processes,
worktrees, disk, adaptive global concurrency and the per-tick claim limit.

### Use spare subscription capacity for frontier work

When fresh `use-it-all.v1` evidence reports `known:true`, `stale:false` and
`behind:true`, a work job launches as frontier on its selected lane if that
executor supports frontier and its cost class is `included`. Holds, quota,
backoff and admission still apply. Eligible jobs run individually so batching
cannot substitute a work-tier model. Existing waste-risk upgrades remain.

`queue/status.json` exposes `tier_upgrades_this_tick`: typed records of `job`,
`lane`, `from_tier`, `to_tier` and a plain-language `reason`. The reason also
persists in `queue/route-state.json` as `waste_reason` and in `ROUTE_BOOST` events.
Run `phm route explain --json` to read it as `lines[].wasteReason`.
`use_it_all_behind` reports each lane's boolean reading or null for unknown,
missing or stale evidence. This bounded policy responds to measured work-tier
underperformance; it does not infer a causal yield gain or train a tier optimizer.

### Resource posture: the lane is a hint

Among otherwise eligible executors, a fresh unused allowance can put the
earliest reset or promotional expiry ahead of the lane hint and ordinary
posture scoring. Antigravity can be prioritized before a burn rate exists when
the enrolled personal Ultra seat has a verified five-hour window with capacity
left. The dispatcher reads that window from `use-it-all.v1` or the matching
`resource-live.v1` observation. Workspace evidence never substitutes for it.
Missing, stale, spent, or passed windows get no deadline preference. This is a
ranking rule for ready work, not a promise to launch without compatible demand.
API lanes classified as metered still require a job to declare
`max_cost_class=metered`. An executor already configured as included may
retain that classification for a fresh, unspent promotional window; missing
credit evidence is treated as metered. An observation never upgrades a
metered executor to included or authorizes spending.

Measured `work-market.v1` posture entries carry `lane`, `account_id`, `model`,
`window_start` and `reset_at`, with the journal row's `ts` proving freshness.
Only usage-derived posture carries reading provenance; host declarations, free
windows, previews and use-it-all overrides do not. Devin uses the weekly API
measurement's scope verbatim and drops a model that differs from the dispatcher
selection. Other lanes normalize budget-reading instants to UTC milliseconds.
Unknown scope is omitted, never invented; incomplete or mismatched receipts do
not establish allowance posture.

Each executor has a posture: `burn` (spend the window on volume), `preserve`
(keep the window for judgment work), or `balanced`. The default is `preserve`
for `codex-personal` and `claude`; every other
executor is `balanced`. The host overrides this with `posture` in `slots.json`.
A `free_until` instant (epoch seconds or an ISO date) reads as `burn` until it
passes, which is how a free-session window on an executor is declared. Nothing
is free by default. Fresh `use-it-all.v1` evidence that an executor's window is
at waste risk or behind pace also reads as `burn` for that tick, so a preserved
window that would otherwise expire unused takes volume.

Fresh measured `queue/budget-overrides.json` allowance also sets posture for
`included` subscriptions only (never metered/API-credit or local lanes).
Per-lane `weekly_used_pct` (0–100), finite nonnegative `burn_pct_per_hour`
(including measured zero), `reset_at` and `as_of` are required. Times accept
epoch seconds or ISO timestamps; observations older than 30 minutes, more than
60 seconds in the future, or already elapsed resets are unknown.
With hours remaining to reset, projected unused allowance is
`max(0, 100 - weekly_used_pct - burn_pct_per_hour * hours)` (see
[projected waste](AMPLIFY.md)). At least 10 percentage points unused selects
`burn` (`spend_down_projected_unused`); projected consumption above 110% selects
`preserve` (`spend_down_projected_exhaustion`); otherwise `balanced`
(`spend_down_on_pace`). Precedence is unexpired `free_until`, valid host-declared
`posture`, measured spend-down, then built-in defaults. Reasons are `free_until`,
`host_declared`, or the spend-down code; defaults retain `spend_down_unknown`
or `spend_down_not_subscription`. The existing use-it-all tick override remains
last, with reason `use_it_all_waste_risk` or `use_it_all_behind`.

The Devin CLI lane derives an allowance-bounded cost class instead of trusting
a `slots.json` cost override. It reads the existing published
`~/.ashlr/devin/weekly-capacity.json` measurement (`phm capacity publish`),
`devin.weeklyAcuAllowance` (falling back to the local budget's `acuBudgetTotal`),
and the configured recurring `devin.weeklyResetAt` anchor. The measurement must
be live, at most 15 minutes old, and belong to the configured window with a
future reset. Unknown ACU values stay null. It counts as `included` only when
`allowance - measured usage - reservations - reserveAcu >= maxAcuPerSession`.
Reservations conservatively hold the full cap of unsettled local Devin tasks
(including suspended/dismissed sessions and ambiguous creates), plus one cap
per running dispatcher session. This can double-reserve a tracked worker;
it protects usage since the weekly observation. Claims in the same tick each
reserve another cap before the next decision. Missing budget or task inventory
makes reservations unknown. No allowance, reset, measurement or sufficient
headroom means `metered`, which cannot burn, including through host posture
or use-it-all overrides. This classification grants no launch authority and
does not change billing, plan settings or the launcher's spending gates.

Selected SWE-2 Lightning/Flash CLI preview models are `included` with
`zero_cost: true` and posture `burn` until 2026-12-01 05:00 UTC (the shared
resource-live expiry). They need no ACU reservation. At expiry they become
`metered`; `free_until` cannot extend them. Tier-specific model picks apply per
job; a batch or tier boost cannot silently substitute a differently priced
Devin model for the cost receipt's selected model.

Devin receipts add `cost_class_reason`, `zero_cost` and nullable ACU `allowance`
evidence. Reasons are `devin_within_allowance`, `devin_allowance_headroom`,
`devin_usage_unknown`, `devin_usage_stale`, `devin_reset_unknown`,
`devin_reset_expired`, `devin_allowance_unknown`, `devin_reservations_unknown`,
`devin_free_preview` and `devin_preview_expired`.

`work-market.v1` routing receipts include `posture_reason` and `spend_down` in
each lane's ranking inputs. When allowance readings exist, one `event: posture`
snapshot per market tick records all lane postures and projections, including
ticks without a routing decision. `phm route explain --json` returns nullable
`posture.lanes` with `posture`, `postureReason`, `projectedUnusedPct` and
`hoursToReset`, using the newest posture snapshot in a bounded 256 KiB journal
tail, or the newest routing decision if no snapshot exists. Missing or invalid
evidence stays null. These ranking inputs never grant quota or eligibility.
Devin's cost evidence is exposed there as `costClass`, `costClassReason`,
`zeroCost` and `allowance` (ACU keys retain their receipt names).

| Posture | bulk | standard | judgment |
| --- | --- | --- | --- |
| `burn` | best | best | neutral |
| `balanced` | neutral | neutral | neutral |
| `preserve` | last | neutral | best |

Fit ranks ahead of the lane hint. Bulk work hinted at a preserved window runs
on a burnable executor that has a free slot, and the decision records
`resource_fit`. Within one fit class the hinted lane wins. When the better-fit
executors are full, held or otherwise unavailable, the job still runs on any
eligible executor, so an idle preserved lane is fed rather than left empty.
Posture is a ranking input only. It never grants a capability, a cost class,
quota, clearance or a slot, and weekly pacing, holds and spend rules apply
unchanged.

Among eligible executors, resource fit comes first, then the hint, followed by utilization,
measured empty rate and yield, cost class, known remaining quota, measured model
latency and stable executor order. Recent finish events supply empty-rate and
`model_s` latency observations, with measured `wall_s` session duration as a
fallback. Audit `latency_source` distinguishes a model phase from total session
time; it never labels total time as model-only latency. An optional `queue/adaptive.json` projection may
supply `{ts,lanes:{"lane-name":{empty_rate,yield_rate,model_latency_s,backoff}}}`;
only observations at most 300 seconds old are used. Missing measurements stay
null in audit data. Advisory observations cannot advertise capabilities, change
a target, clear a hold or enable spending. Unknown model mappings do not invent
a price. Cost classes come from host executor metadata.

## Routing receipts and JSON audit

### Repository shares

The Mac shared queue starts flat: no repository has a fixed rank or guaranteed
top share. Within existing job urgency and safety bands, restock and dispatch
interleave candidates by repository score. Ready depth, CI repair work, bug and
research jobs, and declared mission impact increase the bounded score; dispatch
also considers observed merge rates for comparable work. Recent weekly findings
add 0.35 for docs drift, 0.45 for a stale site, or 0.65 for an unhealthy site,
with reason codes `docs_freshness_drift`, `site_freshness_stale`, and
`site_freshness_unhealthy`. `boost` multiplies the
score by 1.25, `normal` leaves it alone, and `pause` keeps work pending without
admitting new claims on this queue. These are local scheduling settings, not
authority, cancellation or changes to execution constraints.

When shares change, dispatch records `work-market.v1` events named `repo_share`
in `metrics/work-market.jsonl`, with `repo`, `score`, `share` and
`reason_codes` (for example `default_branch_ci_fix_ready` or
`historical_solution_yield`). The allocation displayed in [Repos manager](./ECOSYSTEM-ONBOARDING.md#manage-ecosystem-repositories)
is the target, not guaranteed throughput: runnable capacity, safety gates and
work availability still govern claims. The historical `phm repos rank` report
does not control this queue.


Every evaluated decision appends a private JSON record to
`metrics/work-market.jsonl`. Lifecycle events remain in `metrics/jobs.jsonl`.
The decision shape is:

```json
{"schema":"work-market.v1","event":"route_decision","job":"RQ-MARKET","chosen_lane":"claude","preferred_lane":"codex-personal","work_class":"judgment","override":{"from":"codex-personal","to":"claude","reason":"preferred_lane_fallback","preferred_lane_blocked_by":["saturated"]},"rejected_lanes":[{"lane":"codex-personal","reason_codes":["saturated"]}],"reason_codes":["healthy_capacity","preferred_lane_fallback"],"ranking_inputs":{"claude":{"running":0,"target":2,"quota":null,"empty_rate":null,"yield_rate":null,"cost_class":"included","latency_s":null,"posture":"preserve","fit":0}}}
```

`override` is null unless the job runs somewhere other than its hinted lane.
Its `reason` is `resource_fit` (the hinted lane could run it, another resource
suits the work better), `preferred_lane_fallback` (the hinted lane could not;
`preferred_lane_blocked_by` lists why) or `unknown_preference`. The same reason
is written to the job ledger: the `claim` row in `metrics/jobs.jsonl` gains
`lane_hint`, `lane_override` and `lane_hint_blocked_by` when the claim left its
hint, and a member that joins a combined session on another lane records
`lane_override:"batch_session"` on its `batch_claim` row. The event log line is
`FLEET_REBALANCE <job> <from>-><lane> (shared market: <reason>)`; the reason is
`placement_moved` when the row declared no lane and only its provisional
lane column changed.

Advisory [failover receipts](ROUTING.md#failover-chains) use `lane_override`
codes `failover_quota`, `failover_5xx`, `failover_timeout` and
`failover_near_reset` on `failover` rows. These do not wire the live dispatcher.

Other reason codes include `missing_capability`, `tier_unavailable`,
`tier_ceiling_exceeded`, `repo_unserved`, `data_class_exceeded`,
`cost_class_exceeded`, `quota_exhausted`, `provider_backoff`, `held`,
`no_runnable_lane`, `global_admission`, and `hysteresis_*`. An evaluated job with
no eligible executor records `chosen_lane:null`. No task text or credentials
appear in these records. This versioned event is also an input seam for the Jev
typed-decision learner; it does not itself activate a learner.

Actual assignments persist under `ready.lock` in `queue/route-state.json`.
Enqueue hints have `assigned:false` until a runnable claim. Existing receipts
without that field remain binding. Assigned routes keep the 60-minute residency
and two moves per six hours. Only explicit auth failure or numeric zero quota
permits early movement; congestion and manual holds do not. A recovered or new
launch receipt fixes the pool permanently, including each batch member.
Changing preferences cannot move a running job. See
[route hysteresis](ROUTE-HYSTERESIS.md).

```sh
phm route explain --json
phm pool admission --json
```

## Utilization and unfed capacity

`phm fleet autopilot --once --json` requires a healthy `ready.tsv` read to
identify starved lanes or propose restock. When that read is missing or
degraded, per-lane `ready` stays null. The dispatcher’s `queued` count remains
visible and can include parked work.

An executor is unfed when it has free slots while runnable rows wait under
another lane's hint. Each tick the dispatcher computes this after its launches
and publishes it as `unfed_capacity` in `queue/status.json`: per lane `running`,
`target`, `held`, `utilization`, `headroom`, `waiting_elsewhere`, `unfed`, and
`blocked`, a count per reason code saying why those rows did not run there
(`missing_capability`, `data_class_exceeded`, `provider_backoff`,
`global_admission`, `deferred_after_selection`, `not_evaluated`, and the other
decision codes; `admission_stopped` when the load gate, a pause or the disk
guard stopped the whole tick). Held, full and zero-target lanes are never
unfed. When at least one lane is unfed the same record is appended to
`metrics/work-market.jsonl` as an `unfed_capacity` event, one row per tick. It
holds counts and codes only: no job ids, task text or credentials.

```sh
phm fleet unfed
phm fleet unfed --window 6 --json
```

`phm fleet unfed` prints each resource's utilization and its unfed capacity
now. The fleet-wide `unfedSlots` upper bound sums each unfed lane's smaller
count of headroom and rows waiting elsewhere, capped by total waiting rows
because lanes can see the same work. Actual placement depends on eligibility
and admission. The command then folds the unfed ticks of the last `--window` hours (default 24, at
most 168): ticks unfed and slot-ticks lost per lane, with the leading reasons.
The history includes both endpoints of the trailing window and excludes ticks
timestamped after the report time.
Each historical lane needs an unfed flag, positive headroom and waiting work
elsewhere. A tick counts when at least one lane meets all three conditions.
The separate `resourcePlan` comparison uses the same advisory lane targets as
`phm resources plan` and shows how many additional slots lack waiting rows
hinted to that lane. The advisory `unfedSlots` count stays null when plan
capacity is unknown, dispatcher status is stale, or `ready.tsv` is missing.
Both the lane hint counts and the total waiting work for this comparison come
from the same `ready.tsv` read. An observed empty ready file yields zero
advisory unfed slots because there is no waiting work to move. Dispatcher counts,
reason codes and the command's exit status still describe the actual market.
The same window's `route_decision` rows are folded into `overrides`:
each waiting job counts once, by its latest in-window decision — how many
jobs the market decided and how many left their hinted lane, by reason
(`resource_fit`, `preferred_lane_fallback`, `unknown_preference`) and by
hinted-to-chosen lane. An override counts when its endpoints match the
decision's declared preference and chosen lane, and those lanes differ.
Both lane fields must contain a valid lane or an explicit null. Null
`preferred_lane` records open work and null `chosen_lane` records an unrouted
decision. The dispatcher's `invalid_requirements` receipt records an unrouted
decision with no `preferred_lane`, because validation failed before the hint
could be read. It can supersede an earlier decision for the same job. Other
rows with missing or malformed lane fields are skipped before selecting the
latest decision.
Decision and claim windows include both endpoints and exclude events
timestamped after the report time.
The same collapsed decisions also fold their
`rejected_lanes` into `rejections`: every lane the market refused each job,
with the reason codes that say why (`missing_capability`, `quota_exhausted`,
`saturated`, `lower_rank`, ...). `lanes` tallies each rejected lane per job
with its reason counts and `byReason` counts each job once per reason
across all its rejected lanes; `unrouted` counts decisions that chose no
lane at all. Malformed entries or codes are skipped, never guessed.
The same window's `claim` and `batch_claim` rows in
`metrics/jobs.jsonl` fold into `claims`: launches that actually left their
hinted lane, counted as events — a re-launched attempt is another real
launch — by `lane_override` reason and by hinted-to-launched lane. This is
the launch record the decision fold cannot see: `batch_session` moves a
combined session makes after each member's own decision appear here and
nowhere in `overrides`, and a decision overridden on paper but deferred
before launch never counts. A claim whose hint and launch lane match counts
as a launch only, even if it carries an override code.
`claims.truncated` is true when the ledger
exceeded the retained tail, so those counts are a lower bound.
The same collapsed decisions also join the retained tail of
`metrics/jobs.jsonl` into `decisionOutcomes`: each decided job counts once,
by how its latest decision treated the hint — `hinted` (chose the declared
preferred lane), `overridden` (recorded a well-formed `lane_override`),
`open` (chose a lane with no declared preference), `unrouted` (chose no
lane) or `unexplained` (left a declared preference with no well-formed
override record) — then to the newest recorded outcome through the same
fold `phm router outcomes` uses. This report considers dated merge, close
and revert evidence at or before report time. A later verdict leaves earlier
eligible evidence in place. A recorded revert timestamp takes precedence over
the row timestamp. `byReason` recounts
overridden jobs by override reason and `byClass` tallies outcomes per
recorded `work_class` (`unclassified` when absent or outside the market's
closed values). A missing jobs ledger leaves every decided job
`unresolved` — unknown stays unknown — and `jobsTruncated` marks a
tail-bound lower bound on outcomes.
`marketTruncated` flags a read that omitted older work-market journal bytes.
History, overrides, rejections and decision outcomes then cover only retained
evidence and may be incomplete for the requested window. Text output flags
the same limitation. Each fold's `available` flag still indicates whether
its journal was readable.
`--json` prints `fleet.unfed.v1`. `source` is `dispatcher` when status.json
carries the block and `derived` when the running dispatcher predates it; a
derived report compares lane counts with `ready.tsv` hints; when
`queue/slots.json` also parses it recomputes the same eligibility reason codes
the dispatcher would record (`derivedReasons: true` in `--json`), otherwise
reasons stay unknown. For API lanes whose derived cost class is metered, rows
without `max_cost_class=metered` receive `metered_api_opt_in_required`. The
dispatcher verdict includes any changes in cost class from promotional windows.
Ready rows are validated exactly like the dispatcher's
`work_market.requirements`: a malformed job id, tier or requirements spec —
including a spec-less row whose `queue/router-queue.md` `(attrs)` envelope
fails validation — never reaches the market, so the report counts it in
`invalidRows` and excludes it from `waiting` and the unfed math, matching the
dispatcher's `_waiting` set. Tiers, cost classes and data classes must use
their declared values. On an admission-stopped tick the dispatcher
counts every JID+tier-valid row by its raw lane column instead, and the
derived report follows that. Independently of `source`, `fleetStop` names the
tick's fleet-wide stop in the dispatcher's own codes — `admission_stopped`
when the PAUSE file, disk guard or load gate kept the market from running,
`global_admission` when the launch budget or fleet cap was spent — or `null`
when no stop is recorded. The verdict comes from status.json's `paused`
and `admission` fields even when no lanes have blocked rows. Published
`blocked` codes provide fallback evidence. Derived per-lane reasons use
the fleet-wide stop when one is recorded.
`--json` also carries `statusAsOf` (status.json's `last_tick` as ISO-8601, or
null) and `statusFresh`: the snapshot is fresh only when `last_tick` parses,
is not in the future, and is within the same two-minute window the spend
projection applies; with no evaluation clock freshness stays `null` (unknown),
and a stale or untimestamped snapshot is still reported — flagged, never
hidden — as the dispatcher's last published state. Text output prints the same
caveat after the utilization summary.
It exits 1 when any lane is unfed now and 2 when status.json is unreadable. It
is read-only: no writes or provider calls. The resource plan uses the same
bounded local host and Tailnet evidence as the resource planning command. The isolated fleet
MCP server's `fleet_unfed` tool serves the same `fleet.unfed.v1` assembly —
the same `readUnfedReport` read this command and the tool share — with
`windowHours` taking the `--window` bound; see
[the fleet tool catalog](MCP-TOOLS.md#phantom-fleet--isolated-fleet-server-phm-mcp-fleet).

The Leader records these targets and the projected unused quota per deadline
on the Fleet Board. On a live tick it may also re-hint eligible READY rows
toward under-target included lanes, earliest verified deadline first. A
supported reset proposal may affect that order, but does not spend a reset.
The Leader only edits the existing `queue/ready.tsv` under the dispatcher
and ready-file locks; it leaves held, parked, retired, exclusive and legacy
rows without an explicit requirements cell alone. A re-hinted row cannot
fall back to metered execution. Dispatch still decides whether and where to
launch. The move is recorded in `metrics/work-market.jsonl` as
`work-market.v1` / `queue_reroute` with `resource_plan_under_target` and
`expiring_included_quota` or `expiring_reset_bank`; these are not claim or
route-decision events.

## Dispatch-neutral queue snapshot

The Leader board's `queueDepthByTier` counts READY work across the fleet,
including rows with an empty lane column or an explicit
`"preferred_lane": null` in the requirements. These open jobs have no
per-lane attribution.

`phm queue` owns the separate `queue.v1` coordination snapshot at
`~/.ashlr-runs/queue/queue.v1.json`. `--dir <directory>` selects an isolated store.
The CLI accepts and round-trips the same requirements. Adding to this snapshot
does not append to `ready.tsv` or start a worker. There is no second scheduler
cutover here; live production remains the router Markdown and dispatcher path.
Do not dispatch the same jobs through two schedulers.

## Commands

```sh
phm queue import router-queue.md --json
phm queue list --json
phm queue add RQ-EXAMPLE --priority P0 --tier frontier --needs git,gh,node \
  --repo phantom --scope 'Implement the feature' --acceptance 'Tests pass' \
  --deps RQ-PREREQUISITE --json
phm queue claim RQ-EXAMPLE --owner worker-1 --json
phm queue done RQ-EXAMPLE --owner worker-1 --pr-url https://github.com/ashlrai/phantom/pull/123 --json
phm queue done RQ-EXAMPLE --owner worker-1 --json
phm queue block RQ-OTHER --owner worker-2 --reason 'Waiting for prerequisite' --json
phm queue export --json > queue-backup.json
phm queue export --md --json
```

`claim` requires READY and all dependencies present and DONE. Missing dependencies
fail closed. `done --pr-url` records PR-OPEN without releasing the claim; `done`
without a PR URL records DONE. These are operator-reported states, not evidence
of GitHub merge checks. `block` records BLOCKED and closes the active claim.
Completion and blocking require the last active claim's owner. This is local
coordination, not an authentication boundary. There is no automatic reclaim,
retry, promotion of HOLD/PROPOSED, dispatch, or merge.

`--help` is side-effect free. Unknown commands, flags, irrelevant options and
missing operands fail before mutation. All commands support `--json`, including
errors; failures return exit code 1. `list` and JSON export do not create files.

## Contract and interoperability

The canonical TypeScript contract and runtime validator are in
[`schema.ts`](../src/core/queue/schema.ts). A document contains `schema: "queue.v1"`
and a `jobs` array. Each job has a unique `id`, status
`READY|CLAIMED|PR-OPEN|BLOCKED|HOLD|PROPOSED|SPLIT-PARENT|FIXUP|LAND|DONE|RETIRED|DROPPED`,
`priority`, `tier`, `repo`, `deps`, `scope`, `acceptance`, and `claims`.
The optional compatibility `pool` defaults to `any` when adding a job. Optional `preferred_lane`, `needs`,
`min_tier`, `max_tier`, `max_cost_class`, `data_class`, `work_class`, `exclusive`, and `impact` carry the market contract;
JSON import, replay, and Markdown exports preserve them.
Claims record `owner`, `claimedAt`, and optional `finishedAt`. Jobs optionally
carry `prUrl` and `blockedReason`. Timestamps are ISO dates, PR URLs are
credential-free HTTPS, and self-dependencies and duplicate dependency IDs are
refused. Cyclic dependencies cannot be claimed because all dependencies must be
DONE. A document may also carry `raw` (unparsed job-shaped lines kept verbatim
with a reason) and `warnings` (non-fatal import observations).

The store API is a clean seam for a future scheduler: `read`, `add`, `import`,
`claim`, `finish`, and `mirror`. No executor is imported. Status changes happen
inside the same transaction that checks readiness and dependencies.

Markdown import accepts one job per line in either direction of the live
router format: fields may sit before or after the id, and operational tokens
(timestamps, worker names, pool names) may precede the id:

```text
- READY RQ-EXAMPLE (P0 FLAGSHIP, pool=codex-personal, tier=frontier, repo=phantom, deps=RQ-A|RQ-B, EO 13:45): Scope text. Acceptance: criteria.
- CLAIMED 14:26 dispatchd codex-personal RQ-EXAMPLE (P0, pool=codex-personal, tier=frontier, repo=phantom): Scope text.
- PR-OPEN (https://github.com/ashlrai/phantom/pull/123, bridge 12:23, EO 12:40) RQ-EXAMPLE: Scope text.
```

Bullets are optional; status may use brackets or Markdown bold and IDs may be
bold. Job IDs use the `RQ-` prefix; the job id is the last `RQ-*` token in the
header (everything before the first `:` that follows the first `RQ-*` token),
excluding tokens claimed by a dependency or `children`/`parent` keyword. Field
groups are balanced parentheses, so inner `(...)` pairs do not truncate them.
Fields accept comma or semicolon separators. Routing fields (`priority`, `pool`, `preferred_lane`, `needs`,
`min_tier`, `max_tier`, `max_cost_class`, `data_class`, `work_class`, `exclusive`, `impact`, `tier`, `repo`, `deps`) come only from parenthesized groups; `pool` may also be
inferred from a known pool name in the pre-id tokens. Dependencies use `|`, `+`,
commas, or spaces within the field (CLI `--deps` uses commas), and are also
collected from prose (`deps=`, `depends on`, `after`, `waits for`, `blocked by`,
`needs`, `requires`) anywhere on the line. On the Mac restocker, unmet `after=`
deps become `PARKED-DEP.<lane>` rows whose prompts carry `DEPENDENCY GATE: <ids>`;
restock unparks them when every id has a `MERGED` outcome in `jobs.jsonl` (see
[Mac queue scripts](../contrib/mac/README.md)). `phm fleet dep-gate --json` is the
read-only gate over the same evidence: it scans non-PARKED `ready.tsv` rows and
exits 1 when a queued prompt's declared gate ids are not all MERGED.
`children=`/`parent=` tokens mark
related ids, never the job id or a dependency. `worker=`/`owner=` plus a
`claimed=`/`claimedAt=` ISO timestamp import as a real claim; `reason=`,
`blocked=`, `PR=` and `BASE_OVERRIDE=` text stays intact in `source`. Unknown
fields, headings, comments, whitespace, line endings, and the original text are
retained in `source`. Absent routing fields become `unspecified`, priority
defaults to P2, and absent acceptance becomes an empty string. Such jobs need
operator review before scheduler cutover. Imported CLAIMED and PR-OPEN jobs
without importable claim fields retain their status but have no invented owner
or timestamps, so they cannot be finished through this CLI; jobs that depend on
them cannot be claimed until they are resolved.

Job-shaped lines that cannot be parsed (an unknown status, no `RQ-` id, or a
duplicate id) never abort the import: each becomes a `raw` record with its
line number, verbatim text and reason, and a warning is collected on the
document and printed to stderr by `phm queue import`. Plain prose lines are
left as `source` text, not raw records. Self-dependencies are dropped with a
warning, and an unbalanced `(` is treated as literal text with a warning.
JSON import validates the same schema. Import requires an empty queue; it never
replaces live state. Use a separate directory to inspect a later snapshot.

### Tier values

A router-queue line's `tier=` must be one of `frontier`, `work`, `mid` or
`fast`. dispatchd skips any other value without an error, so the job never
runs. `queuegen` refuses to write a line with another tier, and
`router-lint` reports such an admission line as `invalid` with reason
`unknown-tier`. The refusal names the allowed values and, where one is near,
the closest match: `standard` means `work`, `medium` means `mid`, `low` means
`fast` and `high` means `frontier`. Nothing is accepted by alias; write the
tier name itself. The vocabulary lives in
[`queue-tier.ts`](../src/core/drive/queue-tier.ts). Keep it identical to
`TIERS` in `contrib/mac/dispatchd.py`.

### Tier-scaled session scope

Choose a job's tier for the model that will actually run it. Use `frontier`
for complete features spanning related concerns on models such as
`gpt-6-astra`, Opus or `swe-2-max`; keep small models on `fast`. A model name
or pool alone never upgrades a task's tier. Check the launcher's selected model
before assigning a larger brief.

| Tier | Files per PR | Changed-line budget | Top-level areas in admission lint |
| --- | ---: | ---: | ---: |
| `frontier` | 40 | 600 | 8 |
| `work` | 15 | 200 | 1 |
| `mid` | 8 | 120 | 1 |
| `fast` | 2 | 80 | 1 |

`QUEUE_TIER_SCOPE` in `src/core/drive/queue-tier.ts` defines these planning
budgets. Queuegen FIXUP and REBASE envelopes emit `max-files=` and `size<=`.
The Mac restocker and launcher candidate emit matching scope and acceptance:
finish the complete feature, not the minimum demo; add tests, run them, and
update docs. Frontier briefs can combine related concerns, with **one mergeable
PR per job**. Narrower explicit task limits and named-file restrictions win.
The local-model lane always receives the fast prompt budget.

Admission lint checks declared `EST-LINES` against the tier's line budget
and checks the union of declared and inferred top-level areas. A tierless
envelope uses work defaults. An explicit `size<=` can lower the estimate cap;
`max-files=` can lower the file planning budget. JSON results include effective
`scope: {tier, maxFiles, maxLines, maxAreas}` on valid admission lines. File
counts are prompt budgets, not a measurement of the eventual diff. Missing
estimates remain `review`; unknown or conflicting tiers remain `invalid`.
Unbounded scope is still rejected. Explicit operator `--max-lines` and
`--max-areas` options override tier defaults, with narrower envelope caps retained.

Copy-paste an offline admission example after building the source:

```sh
printf '%s\n' '- READY RQ-FEATURE (pool=devin, tier=frontier, repo=phantom, max-files=40, size<=600): Finish src/feature.ts with test/feature.test.ts and docs/feature.md EST-LINES=600' | node scripts/router-lint.mjs --json
python3 contrib/mac/restock.py --dry-run --json
```

The second command reads local queue state and includes `scope_budgets` in its
JSON plan. Neither command launches work. The restocker and launcher are
repository candidates; Security must review and re-pin them before any live
installation. Existing secret, sandbox, hold-list, publish and merge controls
still apply. Work-only supply writers keep `size<=200`; empty-job retries
retain their deliberately smaller recovery brief. No tracked general prompt
template contains the literal `Under 15 files`; explicit owner-authored caps
are preserved verbatim.

### Queuegen dedupe and empty-outcome suppression

`queuegen` ([`queuegen.ts`](../src/core/drive/queuegen.ts), run by
`scripts/queuegen.mjs`) emits one `- READY` FIXUP or REBASE line per fleet
PR per 24 h, deduped on `<repo>#<pr>` — but evidence-aware: each emission
records the headSha it was minted against, so a moved head releases the
suppression while an unchanged head holds it. Each emission also records
the failure signature (the failing check, or `merge-tree`, plus the
resolved file). When `jobs.jsonl` shows the last two same-signature
attempts all came back empty, the candidate is suppressed instead of
minting another empty job; a changed check or file is a different
candidate and recovers. Missing, unreadable or out-of-window outcome
evidence never suppresses — suppression is advisory and fails open. The
ledger read is tail-bounded via `--metrics` (default
`~/.ashlr-runs/metrics/jobs.jsonl`).

Queuegen reads repositories from the verified, effective standing policy.
Both proposal and merge stages can receive work. An inactive policy or Stop
parks generation. The Mac launcher currently takes AshlrAI checkout names.

Each active repo receives two P2 freshness jobs per seven-day UTC window.
The docs job checks documented commands and examples against current code
and CLI help. The site job checks the configured production deployment and
records its revision and health, including when no site is configured or
the evidence is unreadable. The jobs share queuegen's cycle cap. An active
job carries over into the next window without a duplicate.

Each job reports one standalone `FRESHNESS: <verdict>` line in its worktree's
`BRIDGE_NOTES.md`. Docs verdicts are `clean`, `drift`, or `unknown`; site
verdicts are `healthy`, `stale`, `unhealthy`, `unknown`, or `not-configured`.
Before reaping finished worktrees, the Mac dispatcher saves the latest valid
weekly verdict per repo and kind in `queue/repo-freshness.json`. Only the
current and previous UTC windows count. Missing, unknown, and out-of-window
findings add no weight. The snapshot stores no notes, endpoints, or revisions.

The recut loop ([`recut-loop.ts`](../src/core/fleet/recut-loop.ts)) applies
the same rule to the drop jobs it mints for conflicting fleet PRs: when the
last two attempts it wrote for one PR on the *same head* all finished empty
in `jobs.jsonl`, the candidate is skipped with reason `empty-yield` and the
tick reports it in `skipped` rather than launching a third identical
attempt. A moved head is different work and recovers; a missing ledger
entry, an unmeasured, productive or merged outcome, or outcome evidence
older than seven days each fail open.

The same empty-streak rule guards relaunch at the dispatcher: see
[`contrib/mac/README.md`](../contrib/mac/README.md) for launch-precheck
code 14.

### Merge-queue throughput loop

`merge-queue-loop` ([`merge-queue-loop.ts`](../src/core/drive/merge-queue-loop.ts),
run by `node scripts/merge-queue-loop.mjs cycle [--dry-run]`) makes one pass
over the fleet PRs of the seven approved repos. A green, mergeable PR is
added to the default branch's GitHub merge queue (`gh pr merge --auto` with
`--match-head-commit`, so a moved head is refused); the queue still runs every
required check on the merge group. A BEHIND PR gets `updatePullRequestBranch`
with the MERGE method (a base merge commit, never a rewrite or force-push) only
where it helps: in a repo without a merge queue, or when its head reports no
checks at all; the queue tests against the latest base itself. A conflicting PR gets one fix-forward line per head
under the same `RQ-DRAIN-<repo>-<pr>-<sha7>` id refix-loop uses, so the two
never double-append. Red checks stay with refix-loop. Repos without a merge
queue are never auto-enqueued, and PRs touching Security-pinned paths (or with
a truncated file list) are reported as `pinned`, not enqueued. Each action is
written ahead, spaced 15 minutes apart, capped at 3 per PR per 24 h and 20
per cycle.

The same cycle recovers eligible PRs stranded outside the queue, including
those with auto-merge already armed. Live PR or repository claims in the
coordination ledger report `owned`; unreadable ownership stops that repo.
JSON `repos[].latency` reports each PR's head, state, state entry time (`since`),
observation time (`observedAt`, both epoch milliseconds) and cumulative `stateMs`. Times are sampled
at successful reads: intervals belong to the preceding observed state, not
exact GitHub transition times. New heads, failed reads and backward clocks
reset the timing window; closed PRs are removed. Dry runs report without saving.
The same typed report includes `blockers` (`conflict`, `stale`, `checks`,
`review`) and sampled `blockerMs`, even for `queued` or `owned` PRs. These
durations overlap: pending checks and a stale branch can occupy the same
interval, so never add them to obtain total wait. Blockers start at zero in
each timing window; old state files start measuring on their next successful read.
`checks` reflects the reported head check rollup, not merge-group check results.
`stale` means GitHub reports BEHIND, not that a queued PR needs rebasing.
After an hour continuously observed as queued, `repos[].stalled` lists the
entry. The cycle refreshes its head, holds, ownership, reviews and check status
before using GitHub's `dequeuePullRequest` and the same head-pinned auto-merge
path to restart eligible entries. `repos[].recovered` records successful
re-enrollment requests, not completed merges. Recovery shares enqueue retry
budgets; a failed re-enrollment is retried on a later cycle. New heads, failed
reads and backward clocks reset the observation window. Dry runs only report.
The typed `MergeQueueOptions.stalledMs` controls the timeout; required checks
and reviews remain enforced by GitHub. Dequeueing loses the entry's position
and restarts its merge-group checks, so the timeout is deliberately long.

Each real cycle also feeds the merge-events ledger
(`~/.ashlr-runs/metrics/merge-events.jsonl`, the file `phm fleet
merge-latency`, `phm queue wait` and the router's `merge_queue` outcome join
read) with the transitions it sampled: `eligible`, `queued` and
`checks_passed` at most once per PR, `conflict` once per observed head,
`blocked` when the dominant blocker reason changes (`conflict` > `review` >
`required_checks`; a stale-branch-only wait records nothing), `check_observed`
on each head-rollup change (`required` is never claimed — the rollup does not
identify required checks), and `auto_merge_enabled`/`auto_merge_disabled` on
observed auto-merge toggles tracked across heads — including drops caused by
a pushed head. The toggles feed `phm fleet merge-latency`'s
`pending_auto_merge` and `queue_retries` verdicts; drops the loop can fix are
re-armed by the normal gated enqueue path. Every row's `at`
is the sample instant, never an exact GitHub transition time; dry runs and
`--no-events` record nothing, and `--events PATH` retargets the sink. A sink
failure logs `MERGEQ_EVENTS_ERROR` and never fails the cycle.

A cycle with event recording also runs the bounded merge-retry sweep
(`mergeRetrySweep` in `scripts/merge-queue-loop.mjs`): the same
`phm fleet merge-retry` pass over the same ledger, so a queue-attributed
auto-merge drop the enqueue path cannot re-arm — a `blocked` merge state is
not enqueueable — is re-armed on the pipeline's own cadence instead of
waiting for an operator to run the command. The command's bounds apply
unchanged (at most three requests per sweep, three distinct retries per PR
ever, live state/hold/conflict re-reads, the predicted-conflict skip), the
sweep targets the cycle's `--events` ledger because `retry_requested` /
`retry_failed` rows are the dedupe that makes the bound honest, a
`--dry-run` cycle previews without `--apply`, and `--no-events` skips the
sweep entirely. The compact result lands in the summary's `mergeRetry`
field (`ok`, `known`, `dryRun`, `queue_wait`, per-action counts) and a
constant `MERGEQ_RETRY` line; a sweep failure reports `ok:false` and never
fails the cycle.

Within each repository, ready PRs enter the queue before branch updates and
conflict resolution. Each group keeps PR-number order; already queued PRs
keep auto-merge armed unless eligible for timed recovery. The offline scheduling
fixture in
`test/merge-queue-loop.test.ts` models a 60-second update and a 90-second
conflict resolution: two ready PRs enroll after 0.1 and 0.2 seconds instead
of 150.1 and 150.2 seconds, including when the update fails. These are fixture
times, not measured production latency; repository reads and enrollment API
latency still apply.

`node scripts/merge-queue-loop.mjs metrics --repo OWNER/NAME=CLONE ...`
counts merged PRs per UTC day from each clone's first-parent history
([`merged-per-day.ts`](../src/core/drive/merged-per-day.ts)) and appends
`fleet.merged-per-day.v1` rows to `~/.ashlr-runs/metrics/merged-per-day.jsonl`.
A row is `verified` only when the ref tip closes the day, first-parent dates
are ordered and no PR repeats; a shallow clone that stops inside the day is
reported as `history-short`, not as a low count.

### Stage delegation (bottleneck-only)

Router/leader policy: frontier lanes plan and verify; cheap lanes implement;
only the stage that is the actual bottleneck earns delegated extra capacity.
`plan` and `verify` are judgment stages — they never take the free-first
implement ordering in `tierPreference`, whatever the labelled difficulty,
because a cheap verify proves nothing. `implement` (router task kinds `code`
and `bulk`) is the cheap-lane stage and escalates to frontier ordering only
when it is the declared bottleneck. A delegated run may declare its stage in
`DelegationScope.stage` (`plan` | `implement` | `verify`), which the worker
prompt renders with the stage's lane class. The vocabulary and lane-class
policy live in
[`stage-delegation.ts`](../src/core/routing/stage-delegation.ts) and
[`delegation.ts`](../src/core/types/delegation.ts); the stage-aware ranking is
in [`router.ts`](../src/core/routing/router.ts).

`exportMarkdown` round-trips unchanged imports byte-for-byte. State changes
update the status while retaining original text and append a comment with claim,
PR and block metadata. JSON export is the complete backup and restore format.
`export --md` writes `queue.mirror.md` with a read-only notice and mode 0444 on
POSIX. It never overwrites `router-queue.md`; the mirror is not an input channel.

## Self-decomposition (spawn.v1)

A worker that holds a CLAIMED or PR-OPEN job may propose bounded children
through a `spawn.v1` document — agent self-decomposition without dispatch
authority. The proposer names `parent` and `owner` (which must hold the
parent's active claim) plus 1-8 `jobs` carrying `scope`, `acceptance`,
optional `deps` (existing or sibling ids, never self), and optional `tier`
and `priority` fields. Child ids are `RQ-*`; omitting `id` derives a
deterministic content hash so replays dedup. Intake is atomic: any policy
violation fails the whole proposal, while ids already present in the queue
(any status) or in the `jobs.jsonl` merged ledger are skipped as duplicates.

Children land as PROPOSED with `parent` and `depth` lineage recorded on the
job and emitted as `parent=`/`depth=` fields on exported lines. The intake
is fail-closed bounded: at most 8 children per parent ever, at most 4
accepted proposals per parent per 24 h (a `spawn-proposals.jsonl` journal
beside the snapshot; a corrupt journal refuses rather than unlocking the
cap), and a decomposition depth cap of 2 — grandchildren cannot spawn
further. There is no credential or lane escalation: children always inherit
the parent's `pool` and `repo`, may only take an equal-or-lower tier
(`fast < work < mid < frontier`) and equal-or-lower urgency (`P0`-`P9`, the
digit must not beat the parent's), and must satisfy the standing pool-kind
routing policy. Scope and acceptance are prompt data: bounded to 4 000 and
2 000 characters, free of control characters, and refused outright when they
carry secret-shaped material — the rejection never echoes the text.

```sh
phm queue spawn ./spawn.json --dir <queue-directory> --json
cat spawn.json | phm queue spawn - --json
phm queue serve --port 8471 --token-file ~/.ashlr-runs/queue/spawn-ingest.token --json
```

`phm queue serve` exposes the same planner as a small loopback-only ingest
API (`POST /v1/spawn` on 127.0.0.1, `GET /v1/health` for liveness), gated by
a bearer token kept in a mode-0600 file that is created on first run and
never printed. The API is value-blind: request bodies are never logged and
error bodies carry rejection codes only (`invalid-document`,
`unknown-parent`, `parent-not-active`, `owner-mismatch`, `depth-cap`,
`children-cap`, `rate-limited`, `tier-escalation`, `priority-escalation`,
`pool-routing`, `unknown-dep`) — never submitted text. PROPOSED children are
not claimable; promotion to READY is the operator act `phm queue promote <id>`,
and no ready.tsv or dispatchd wiring is implied.

## Specialist coordination and teammate reservations

The [orchestration cycle](FLEET-COORDINATION.md#leader-orchestration) proposes
specialist assignments from existing queue and outcome evidence. Applying it
records advisory peer messages and a journal; the existing dispatcher still
claims and executes jobs. A journal status of `admitted` is not execution proof.

[iMessage teammate tasks](IMESSAGE.md#fleet-teammate-tasks-and-evidence) reserve
an exclusive CLAIMED job for `imsg:<peer>` when enqueue is applied. They do not
enter the ordinary READY worker pool. A matching peer DONE result settles the
local claim, while BLOCKED/FAILED, expiry or an allowed unsent withdrawal
settles it as BLOCKED. These are local bookkeeping outcomes; independently
verify peer-reported work before relying on a completion claim.

## Storage and failure behavior

Every mutation and mirror export acquires `queue.v1.lock` with exclusive file
creation, then reads and validates the snapshot under that lock. Concurrent
callers wait up to five seconds. Updates use a unique private temporary file,
fsync its contents, and atomically rename it over the snapshot. Readers observe
a whole old or new snapshot. Files use mode 0600 and newly created directories
use 0700. The existing dispatchd directory's permissions are not changed.
Corrupt snapshots fail closed instead of becoming empty queues.

## Check ready work against free slots

Use these read-only reports when a lane has room but jobs are not starting:

```sh
phm fleet lane-starve
phm fleet lane-starve --json
phm fleet launchable
phm fleet launchable --json
```

`lane-starve` lists lanes below their launch target with queued work. Its
`ready` count splits into `filler` and `real` rows. It counts bare job rows
and rows explicitly marked `READY` in the first column. Other recognized
statuses such as `CLAIMED`, `RUNNING`, and `DONE` are excluded, as are rows
with a `PARKED` marker in either the first column or the lane column.
`queued` comes from the status snapshot, so it can differ from `ready`.
When `ready.tsv` is missing, the split reads `unknown` in text and all three
counts (`ready`, `filler`, `real`) are `null` in JSON. An empty file yields
zero counts. Lane selection and the exit code still use the status snapshot.
Lanes with `held: true` in the dispatcher snapshot are excluded.

`launchable` compares each lane's `free` slots with ready rows whose prompt
file exists. A row counts toward the lane its market hint resolves to: the
requirements cell's `preferred_lane` — or the matching `router-queue.md`
`(attrs)` envelope for a spec-less row — wins over the lane column, an
explicit `null` — or an empty lane cell — is lane-open, and a row the market
would reject (bad job id, repo, tier or spec) is dead work, never launchable.
Lane-open rows are shared supply any lane may take and are reported once as
`openRows` (the text output names the count). The first eligible row for each
job ID determines its hint in this report. Duplicate copies cannot fill
additional slots or contribute to both lane-hinted and lane-open supply.
The report also excludes parked rows,
jobs marked `drop` or `defer` in `skipped-empty.tsv`, and filler while
`FILLER_HOLD` exists. Both commands use the launch target described below and
read `~/.ashlr-runs/queue` (including `router-queue.md` for `launchable`);
set `ASHLR_RUNS_DIR` to inspect another runs directory.

`launchable` reports zero free slots for a lane with `held: true`, while
keeping its published occupancy, launch target and ready supply visible.

The leader's compact brief (`leader.compact-brief.v1`) counts each lane's
`queued`/`queuedReady` by the same market-resolved hint, reports lane-open
rows once as `openRows`, and credits that shared supply before calling a
lane supply-starved; `null` stays unknown when `ready.tsv` cannot be read.

`lane-starve` exits 1 when it finds a starved lane; `launchable` exits 1 when
any lane has more free slots than launchable rows plus lane-open supply — a
lane is under-supplied only when even all open rows could not fill it. Both
exit 0 otherwise and 2 for invalid arguments or unreadable required data.
Their JSON schemas are `fleet.lane-starve.v1` and `fleet.launchable.v1`.
Neither report launches work or removes a hold.

## Inspect the processes using this computer

```sh
phm fleet hostload
phm fleet hostload --json
```

This read-only report shows up to eight process families, ordered by CPU,
with child builds and tests counted with their parent job. It also lists up
to five unrecognized executable names with process counts, CPU and RSS memory;
command arguments stay private. JSON includes `families`, `unknownCommands`,
`fleetCpuPercent` and `totalCpuPercent`. CPU uses the process convention where
100% is one core, so totals can exceed 100% on a multicore computer.

An unknown executable is a classification gap, not proof that it belongs to
the fleet. If process data cannot be read, `state` is `unknown` and the command
exits 1; a known reading exits 0. Use the admission report below to see whether
load is blocking new jobs.

## Load-aware admission

`phm pool admission [--json]` is a read-only report of the dispatchd load gate:
1-min loadavg and its limit, `ncpu`, process and live-worktree counts, the daemon
tick age, the global running cap, running jobs, the `queue/install.lock` holder and
`admit` true or false with the reason. It claims and launches nothing. The gate
logic itself lives in `contrib/mac/dispatchd.py`; see `contrib/mac/README.md`.
The global cap is adaptive (RQ-QUEUE-BATCH-1). dispatchd raises it while load,
memory, swap, disk, process count and provider rate limits have headroom, and backs
off before they run out. The report shows it as `adaptiveCap`. An operator
`hard_cap` in `slots.json` is optional; without one, `hardCap` is `null`. The same
change batches related ready tasks into one agent session. See
[adaptive concurrency and batching](../contrib/mac/README.md#adaptive-concurrency-and-batching).

`ashlr fleet admission` shows one line explaining job starts from
`~/.ashlr-runs/queue/admission-ctl.json`. The Fleet overview's **Job starts** card
uses the same reader through `GET /api/verse/fleet/admission`. `--json` returns
the typed measurements, `nextStartSeconds` and `startsPerHourCap` (`3600 / settle_s`;
null for zero settle, which imposes no pacing cap). Missing, invalid or older-than-five-minute
observations are unknown. The guard timestamp may be Unix seconds or ISO 8601
with an explicit time zone (including offsets such as `-0500`). The dispatcher
writes a different report to `queue/admission.json`; use `phm pool admission`
for the dispatcher load gate, not `ASHLR_ADMISSION_CTL_PATH` pointed at that file.
Host blocks show the pacing window separately: its
expiry does not promise a launch while the host remains busy. Exit codes are
0 open, 1 blocked or settling, 2 unknown or bad arguments.
`ASHLR_ADMISSION_CTL_PATH` overrides the admission file; `ASHLR_RUNS_DIR`
overrides its default runs directory. This is a read-only observation of the
launch guard; lane holds and other dispatcher gates can still prevent work.

`ashlr fleet admission --details [--json]` preserves the earlier lane report
and JSON shape. It reads that stored verdict from `queue/status.json`
and says why each lane is waiting: held, at target, admission closed (the
dispatcher is not admitting — load gate tripped or paused), blocked by the global
cap, or ok. `global.closed` is the fleet verdict (cap, gate or pause) and
`global.non_cap_closed` marks a block the cap cannot explain. It does not probe
the host or launch work. It exits 1 when any lane is admission closed or blocked
by the global cap with 5 or more jobs queued. Other waits are
`ashlr fleet lane-idle`, which explains each under-target lane from the same verdict as held, nothing queued, admission closed, blocked by the global cap, or queued work not launching.

These lane reports count availability against the **launch target**: the lane's
configured `target` tightened by the `effective_target` the fleet controller
publishes after load shedding (`min(target, effective_target)`, the configured
target when the shed is absent or unreadable). A lane running at its shed ceiling
has no phantom room, so `fleet admission --details`, `fleet lane-idle`, `fleet lane-share`,
`fleet lane-starve`, `fleet starved`, `fleet launchable`, `fleet idle-lanes`,
`fleet trim` and the idle-lane checks in `fleet doctor` and the bottleneck ideas
all measure "under target", "full" and "starved" against it. `fleet trim`'s
`SLOTS` suggestion still retunes the configured target it would change.

`ashlr fleet idle-lanes` takes the newest event for each lane at or before
report time from the bounded tails of `metrics/jobs.jsonl` and the legacy
`queue/jobs.jsonl` under the runs directory. Events need a lane or pool and a
timestamp with a timezone offset. A lane without a matching event has unknown
age and cannot be marked stuck.

`ashlr fleet lane-share [--json]` reads the same file and prints each lane's share
of the fleet: one line per lane with running of launch target and queued, marked `starved`
(10 or more queued and none running) or `full` (running equals launch target), then one
line with fleet running against the admission cap. It exits 1 when a lane is
starved while the admission reason starts with `at_cap` — queued work parked
because the whole fleet is full, the case `ashlr fleet trim` suggests a slot move for.

`ashlr fleet starved [--json]` reads the same file and prints only the lanes that
still have queued work: running of launch target and queued, marked `starved` when a lane
is below its launch target while the admission reason starts with `at_cap`, then one line
with the admission running, cap and reason. It exits 1 when any lane has 10 or
more jobs queued and none running.

It also names a lane that has free slots and nothing ready to run on them, the
reverse case: `claude: 8 free slots, 0 ready rows for 42 min; next step: add work
for claude`. Those lines come first, followed by the count of READY rows waiting on
a held or drained pool that a starved lane could run instead. `--json` adds
`starved_lanes`, `waiting_elsewhere` and `open_rows` under the `fleet.starved.v1`
schema, and the command exits 1 when a lane is starved. The same data is the `starved` object of the
`fleet.lanes.v1` read (`phm fleet lanes --json`, `GET /api/fleet/lanes`): per lane
`free_slots` (slot target minus running, 0 when held), `ready_rows` and `starved_since`,
plus read-level `open_rows` — the lane-open READY rows (no lane hint) the market
may place on any lane. Open supply keeps a free lane from reading as starved.
Both ready counts come from a healthy `ready.tsv` read. A missing or degraded
read leaves both counts null and suppresses the starvation verdict. The lane's
separate queue depth can include parked work from dispatcher totals. A lane
must be unheld and below its slot target to be starved. When both the configured
target and the dispatcher's `effective_target` are known, the lane view uses the
lower value. The desktop lane
card (Ops, Lanes on this Mac) shows the same line. The Leader posts one chat notice
when a lane has been starved for 30 minutes, at most once per lane every 6 hours,
and remembers first sightings in `~/.ashlr/vision/leader/starved-lanes.json`. The
router queue is never written.

Each lane in the `fleet.lanes.v1` read also carries one `health` verdict:
`{ state, reason, number }` with `state` one of `ok`, `held`, `starved`, `wasteful`
or `drained` and a one-line reason that starts with the state, for example
`starved: 5 free slots, 0 ready rows for 40 min`. When two apply the order is
drained, held, starved, wasteful. A lane is wasteful when it started 5 or more jobs
(distinct `launch` events in `jobs.jsonl`, new `startsInWindow` field) in the merge
window and fewer than 1 PR per 5 starts merged. The schema id stays `fleet.lanes.v1`:
`health` and `startsInWindow` are additive. `fleet.live-map.v1` lane nodes carry the
same `health`, which the 2D map, the 3D map and the desktop lane card show as a
colored badge with the reason as its tooltip; `phm fleet lanes` prints a line for
each lane that is not ok.

Locks are never stolen on age or PID heuristics. If a writer crashes, an operator
must confirm that no writer is running before removing its orphaned
`queue.v1.lock`. A busy lock leaves the snapshot unchanged. A crash before rename
can leave an unused temporary file; it is never read as queue state. Atomicity
assumes a local filesystem with exclusive creation and atomic rename. Directory
entries are not fsynced, so sudden power loss is outside the durability guarantee.

The host dispatchd README was not accessible in the implementation workspace.
`test/fixtures/queue/router-queue-live.md` is a scrubbed snapshot covering every
status prefix and line shape observed in the live queue; the suite imports it
with zero unparsed lines and round-trips it byte-for-byte. Verifying the real
snapshot end to end remains a required cutover step, not a claimed validation.

## Replay failed attempts

`ashlr queue replay --failed --since 2026-11-02T00:00:00Z --query repair --dry-run --json`
lists proposed READY runs without writing. Remove `--dry-run` to persist them.
Failed means BLOCKED with a finished claim; `--since` filters that completion
instant inclusively and `--query` matches job ID, repo, scope, acceptance or reason
(case insensitive). Omit either filter to include all failed attempts.
`--mode replay_failed` is the default. `--mode replay_failed_and_dependents`
includes transitive dependents in dependency order and maps their dependencies
to replay runs. Active original dependents must finish before replay. Claims still require
all dependencies DONE. Each new run records `replayOf` (the original run ID)
and `replayedAt`; original runs remain unchanged. Concurrent or repeated requests
reuse active READY, CLAIMED or PR-OPEN replays. Completed replays allow a later
explicit replay. Queue snapshots persist lineage across process restarts.

## Group failed jobs by error

`ashlr issues` (also `phm issues`) reads the queue and groups failed jobs (BLOCKED
with a finished claim) by their error text. Ids, timestamps and long numbers are
ignored, so one problem counts once. Each group shows a count and a few sample
job ids. It never writes unless you add `--retry`, which queues one READY retry per
failed job using the same lineage as `queue replay` (repeats do not duplicate).
Add `--json` for `{ v, failed, groups: [{ error, count, samples, jobs }] }`, or
`{ v, retried: [{ id, retry }] }` with `--retry`. Use `--dir` to pick a queue directory.
# Lane queue counts

Run `phm fleet queue-counts --json` for ready, parked and running counts and
the oldest wait per lane. `oldestWaitSeconds` covers ready and parked jobs and
measures each job's current queue dwell in `~/.ashlr-runs/metrics/jobs.jsonl`:
`enqueue`/`queued` rows, `launch_failed` retries and retried `task_outcome`
rows are arrivals, while `claim`, `batch_claim` and `launch` end a dwell, so a
re-queued job's wait restarts at its re-arrival rather than its first-ever
enqueue. It is `null` when there are no waiting jobs, the queue or metrics are
unavailable, or any waiting job's arrival is unevidenced — including silent
requeues (deferred launches, released batches) that leave no ledger row. The
command reads up to 2 MiB at each end of the metrics ledger — the oldest
events near the head and the newest at the tail — so a job whose arrival
event falls between the windows counts as missing evidence, never as a
shorter wait. Without `--json`, the same command prints a plain-language
report. Use `--root /path` to inspect a different runs directory.

Trailing-hour merge counts use a readable, timezone-qualified `mergedAt` on
merge ledger rows when available. Older rows and rows with an unreadable
`mergedAt` use the existing ledger event timestamp unless a retained receipt
records a readable `mergedAt` for the same PR, or the same job for a row without
a PR identity. This applies even when the explicit merge time is outside the
reporting window. Matching job-only `LAND` queue rows also defer to that time.
When a timed merge borrows a lane from another merge receipt, that receipt
must have a readable merge or event timestamp at or before report time.
When the merge ledger is missing or degraded, a lane with no observed merges
reports `null`. Observed counts remain visible and may be incomplete. The
fleet-wide total, including the Leader board total, requires a healthy ledger.

Blocked jobs are the parked ones. Each lane has `blockedReasons`
(`[{ reason, count }]`, biggest first, e.g. `DEP` or `HOLD`) and `stale`, the
parked dependency jobs whose gates all show MERGED but were never unparked
(capped at 50 per run). `totals` carries the same two fields across lanes. The
top-level `sources` (`ready`, `running`, `ledger`: `healthy`, `missing` or
`degraded`) and plain-words `notes` say which file made a count `null`, so an
empty queue (zeros, no notes) is never confused with unavailable data
(`null`, with a note).

## Incident pipeline

`phm incident report --kind error --repo ashlrai/phantom --message "<text>"` turns a
production signal (`error`, `log-anomaly` or `bug-notice`) into one bounded READY fix
job. The message is scrubbed and fingerprinted like `phm issues` (ids, times and long
numbers ignored), so repeats join the open incident instead of queueing again. Severity
comes from `--severity` or is inferred from the text and `--count`: sev1 is P0 frontier,
sev2 P1 mid, sev3 P2 fast, and sev4 is only recorded. Each repo may open 2 jobs an hour
and the fleet 6 (sev1 skips the repo cap and may use a hard cap of 12). `phm incident
receipts` messages the reporter once per incident whose job is DONE; a recurrence within
24 hours reopens it as a regression (`INC-<fingerprint>-<n>`). Messages go to Telegram
only when proactive comms are on. State lives in `~/.ashlr-runs/incidents`; `--dir` picks
the queue directory. Both verbs take `--json`.

Pass `--target-revision <full-git-sha>` to scope recovery to an exact revision
(40 or 64 hex characters). Concurrent repeats for the same repository, failure
and revision share one active job. A changed revision permits a new job and keeps
the old revision's deduplication history. Omitting the flag retains the existing
revisionless scope. A finished failed attempt queues a retry one severity higher,
up to sev1; holds and unfinished blockers remain duplicates. Hourly caps still
apply. Agents use the same path through `ingestSignal({ targetRevision, ... }, deps)`.

## Repeated single-case work

When the dispatcher's 24-hour `codex-personal` empty rate exceeds 25%, the
Mac restocker admits at most one active author-filler job for a repository and
explicitly named test file when the task says it adds one test case. Other
matching rows remain READY for a later pass, with the skip reason
`duplicate-single-case-test-file`. Guardian jobs, substantive jobs, different
files, and an unknown rate are unaffected. This groups admission by test file;
it does not merge task text or mark skipped rows complete. The current narrow
match uses filler IDs ending in `A` plus at least six digits and `Q8`, and
`.test` or `.spec` paths. Restocker changes need a Security re-pin before live
installation.

## Plan restock batches

Run `phm fleet restock plan --json` to check READY candidates in
`~/.ashlr-runs/queue/router-queue.md` and plan one job per 6–10 eligible items
from the same repository. This is read-only: it does not enqueue or launch jobs.
The planner runs the dispatcher's installed `bin/precheck.sh` before grouping;
code 13 items are excluded, not declared completed. Unavailable checks also
exclude items for this plan. Re-run planning after restoring the precheck.

The typed `fleet.restock-plan.v1` response contains `jobs` (stable job ids,
repository, original items and combined prompt), `excluded` (id, precheck code
and reason), `held` (ids waiting for enough items), and `invalid` (admission
lint drops). Groups smaller than six wait for more work. No candidate task text
is executed by the planner. The planner does not install or change host scripts.

## Find repeated router jobs

Run `phm queue dedupe --json` to preview repeated READY jobs in the local router queue. Add `--apply` to mark repeats `SUPERSEDED-BY-<first id>`, or `--file <path>` to inspect another router queue. The first READY or CLAIMED line wins. Matching uses the repository, first named target file, and either normalized acceptance text or the same quoted acceptance phrase. Lines missing evidence are reported as unknown. This is a partial, text-based check; review quoted matches for different intended outcomes.

Run `phm queue dupcheck <job-id|prompt-file> [--json]` before launching a job to see whether its work is already on master. It pulls the commands (`phm foo bar`), flags, file paths and panel names out of the goal and looks each up in the CLI command list, `docs/CLI-REFERENCE.md`, the file tree and the pull requests merged in the last 7 days in `metrics/jobs.jsonl`. It prints `likely_done`, `partial`, `new` or `unknown` (the goal names nothing to look up) with the matching file or PR; a job id is read from `queue/ready.tsv`. `--json` carries `schema: "queue.dupcheck.v1"`. Read-only; the dispatcher can call `dupcheckJob` from `src/core/queue/dupcheck.ts`. An existing file alone never proves the work is done.

The dispatcher runs the same check as a gate before it claims a row: `phm queue dupcheck <prompt-file> --gate --json` (schema `queue.dupcheck-gate.v1`). High confidence (this job id already merged, or every named command, flag and file is there and a named flag exists) means `skip`: the row is dropped as `DONE-NOOP`, never launched, and the reason and evidence (matching file, command or merged job) are recorded. Medium confidence (`likely_done` without that proof) means `warn`: the row launches and `contrib/mac/launch_precheck.py` adds one `Check this first:` line to its prompt. Everything else launches as before. Each decision is one row in `metrics/dupcheck.jsonl`; the daemon's `empty-tag-sync` job and `phm jobs empty --record` add an `outcome` row when a launched or warned job ends EMPTY `already_done`. `phm queue dupcheck --stats [--json]` (schema `queue.dupcheck-stats.v1`) shows skips, warned and plain launches, launches that ended `already_done`, and false skips (a skipped job that was launched later). The gate fails open: if `phm` is missing, slow or answers anything unexpected, the row launches.

`phm ideas list` reads the same ledger as its `dupcheck-gate` signal: two or more skipped jobs that were launched later become a `dupcheck-gate:false-skips` idea, and jobs the gate let through (launch or warn) that still ended `already_done` become a `dupcheck-gate:missed-duplicates` idea once at least 3 did so and they are at least 10% of let-through decisions. A missing or unreadable ledger leaves the signal unknown.

Run `phm queue autofill --lane <lane> [--min <n>]` to keep a lane from running dry. When the lane has fewer than `--min` ready jobs (default: its slot target) it drafts the gap in this order: open items from `phm ideas` (`source: "idea"`), then "Not built:" / "Gaps:" lines from the logs of jobs that ended empty in the last 72 hours (`"follow-up"`), then `phm bets propose` (`"bet"`). It skips anything already queued, running or shipped, and any job family that `phm jobs empty --by-family` marks `stop` for the lane. Every queued prompt starts with "Step 0: search master, deliver only the delta; end with no change if it already exists." and the ship-partial rule. It prints `{schema: "queue.autofill.v1", lane, running, target, queued, drafted: [{id, source, goal, prompt, ...}], skipped}`. A source that cannot be read adds nothing. It is a dry run; `--apply` adds each draft as a READY job through the normal queue add path. A full lane prints "Lane is full."; counts that cannot be read stay `null` and nothing is drafted.

`phm fleet self-tick` runs the same fill for you: in its planner-tick step, every lane that `phm fleet pulse --alerts` reports as starved is filled with `--apply`, at most 4 bets per lane and 12 in all per rolling hour. Each run that did or refused something is one `AUTOFILL {...}` line in `queue/dispatch-events.log` with `{schema: "queue.autofill.event.v1", ts, lane, drafted, applied, skipped, reason}`; a lane at its cap is skipped with reason "hourly cap". `phm queue autofill --status [--json]` prints `{schema: "queue.autofill.status.v1", ts, off, cap, last_runs}`: the last runs and the bets left this hour (`off` is `null` when the live config cannot be read). Kill switch: `phm fleet config set autofill.off 1 --reason "<why>"` makes the tick skip with reason "autofill off"; `phm fleet config unset autofill.off --reason "<why>"` turns it back on. Bets are read from the checkout the timer runs in.

Run `phm queue supersede` to list queued jobs that a newer cycle of the same job replaces, for example `RQ-PHX-RECUTCOREC541` once `RQ-PHX-RECUTCOREC544` is queued. Jobs match when they share a repo and an id that differs only in its cycle: `C<number>`, `<number>S` or `<number>C` at the end, with two or more digits. Only the newest cycle stays; ids without a cycle, parked rows and running jobs are left alone, and a claimed or running newer cycle still replaces an older queued one. It reads `ready.tsv` and `router-queue.md` and changes nothing by default. Add `--apply` to copy the older `ready.tsv` rows to `superseded.tsv` beside it, mark their router lines `SUPERSEDED-BY-<newer id>` so restock does not add them again, remove the rows, and append one `SUPERSEDED <id> by <newer id>` line per job to `dispatch-events.log`. Nothing is deleted: to restore a job, paste its row back from `superseded.tsv`. A second run finds nothing to do. `--json` prints the typed `queue.supersede.v1` report (`applied`, `queued`, `count`, `superseded[]` with `id`, `repo`, `family`, `cycle`, `supersededBy`), and `phm queue batches` shows the count as `superseded`.

Restock also checks semantic goal overlap before admitting READY rows. Within the same repo, a shared explicit file/module and normalized token Jaccard score of at least 0.5 marks `DUPLICATE-OF-<id>`; CLAIMED/RUNNING rows take precedence, then the first READY row. Different explicit PR targets stay separate. Paths, stop words and generic single-case scaffolding do not count as goal tokens; fewer than three tokens is unknown. `phm queue dedupe --json` exposes these matches as `reason: "semantic-goal-overlap"` with `jaccard`, and restock JSON includes `dedupe.repeats` and `dedupe.unknown`. This partial check uses router-queue text, not external running-process or PR inventories; other ingest paths are not covered. Live restock adoption still requires Security review and re-pinning.

### Suggest work for an idle lane

Run `phm fleet supply --lane codex-personal --n 5 --json` from the Phantom
checkout. It suggests READY lines from open TODO issues, unchecked root
`ROADMAP.md` items and `// TODO(owner)` source comments. It reads the local
`~/.ashlr-runs/queue/router-queue.md` to skip matching title hashes; it does
not add lines to the queue. The JSON reports the requested count, emitted
lines, gap and each source's status. An unavailable source is `unknown`;
if the queue is unavailable no lines are emitted because deduplication cannot
be verified. GitHub reads are public and may be unavailable or incomplete.
Without `--lane` and `--n`, `fleet supply` retains its batch activity report.

### Generator yield

Run `phm queue yield --since 24h --json` to compare generators from the local
`metrics/jobs.jsonl` ledger. The Metrics screen shows the same 24-hour report.
Events in the window are joined by job ID. An explicit `src` takes precedence
over the job ID pattern; unrecognized sources are `unknown`. The fold uses
recorded timestamps, with ledger order breaking ties. Late arrivals with
older timestamps cannot overwrite newer recorded measurements. PRs and merges
count jobs with recorded PRs and merges. A batch member counts as launched
when the window contains its `batch_claim` and the matching worker's launch
receipt has an equal or later recorded timestamp. Each member counts once.
Batch worker totals and node-pool attempt
telemetry are excluded from generator yield. Empty rate uses jobs with a recorded
empty result. Median diff lines uses recorded `diff_lines`. Tokens per merged PR
is the sum of recorded job tokens divided by merged PRs; it is unknown if any
job in the group lacks a token total or no PR merged. Missing measurements are
unknown, and malformed lines are skipped and counted. The report describes
recorded evidence, not necessarily every job or PR.

The same command reports `drafted`, `rejected`, `launched` and `prs` by
generator, with `rejections` counts by reason. Autofill `--apply` records
decisions in `metrics/generation.jsonl` with job ID, timestamp, `src`
(`autofill:idea`, `autofill:follow-up`, `autofill:bet`), event and rejection
reason. Dry runs expose `trace` in their JSON without writing metrics.
Drafted means accepted for queueing; an hourly cap is a rejection. Duplicate
and completed targets retain their source; targets without an ID use a title
hash. Counts deduplicate by source and target within the window; stages can
overlap. The latest explicit `src` on a job receipt takes precedence over draft
evidence. Without an explicit job source, a single recorded draft source receives
credit for the job's launches and PRs. Competing draft sources leave that credit
under `unknown`, while each source retains its own draft count.
Rejections never claim another generator's results. `generationKnown: false`
means the generation ledger is unavailable; `jobsKnown` does the same for the
jobs ledger. If either journal is missing or unreadable, the report still
includes evidence from the readable journal. Interpret counts using the
availability flag for the journal they depend on.

Empty-tag backlog discovery and the daemon's empty-tag sync both use
finishes from each job's latest observed dispatch attempt in their ledger
windows. A launch or batch claim supersedes earlier finishes, so a retry
awaiting its own finish is excluded from the backlog's empty and untagged
counts. Receipt timestamps determine the order, with ledger order breaking ties.

The self-improvement discovery feed queues recurring refusals after four
distinct recorded rejection observations for one source and reason across
at least two UTC days in the last seven days. Replayed decisions with the
same job, source, event, reason and recorded instant count once in both the
recurrence threshold and the refusal share. Later observations for the
same job still count.

Run `phm fleet lane-reward --json` to see reward and measured token usage by
lane. The report attributes a PR outcome that carries only a URL when exactly
one distinct job in the retained jobs ledger records that URL. If several jobs
record it, the outcome remains unattributed. Rows that identify a job directly
still apply to that job. An `unknown` lane field leaves the last observed lane
in place or allows a valid `pool` or `arm` alias on the same row. Jobs with no
observed lane appear under `unattributed`.

## Fleet resource capacity advice

`phm resources plan --json` joins verified allowance deadlines and remaining
quota to registered machines, their current CPU and memory headroom and free
slots, dispatcher lane caps and ready counts, and recent finishes in
`metrics/jobs.jsonl`. It models **additional** work: already-running jobs
occupy slots but are not credited with future quota spend. Headroom must be
observed and positive for a machine to offer extra slots; a shared slot can
only be allocated once. Unhinted work and future arrivals are not counted.

Waste is in the allowance's own units. Where there is a quota change and
matching finishes inside the observation interval, the estimate uses the
observed quota per token times measured tokens per job, or observed quota per
finish when token coverage is incomplete. It is a projection, not billing
attribution: shared accounts can have usage outside Phantom. Missing data stays
`null`. A fresh snapshot does not guarantee the same resource headroom later.

`phm resources plan --json --write-advice` explicitly publishes a private
queue sidecar. The dispatcher uses it for five minutes as a tie-break among
otherwise eligible lanes at the same deadline, cost posture and fit, favoring
lanes below their advised concurrency. It cannot raise actual targets or
bypass holds, spend policy, quota, job constraints, or machine admission.

## Is each pool fed?

Run `phm queue supply` for one plain line per pool: usage left, hours to reset, jobs queued for the pool, its starts
per hour over the last 6 hours, and the hours of work queued (ready jobs divided by starts per hour). Pools that need work
come first: "Claude: 0 jobs queued, 16% left, about 3 hours of usage idle" or "codex-personal: 104 jobs queued, plan used
up until Sat 3:30 PM". `--json` returns `queue.supply.v1` for agents. It is read-only and built from `phm pools`, the
ready queue and the dispatch events. A figure that cannot be read is `null` and shown as unknown. A missing `ready.tsv`
leaves the ready count unknown and suppresses the `supply_low` alert. An observed empty file counts as zero. Ready jobs
are counted by the lane the work market resolves for the row — its requirements `preferred_lane`, read from the row's
spec or its router-queue.md envelope when the row carries no spec, else the lane column — so a job the market leaves
lane-open, or one it would reject, is not counted.

The hourly digest adds a `supply_low` line, naming the pool, when a pool that is behind (or has waste risk high or
medium) has under an hour of work queued. The alert uses the observed ready and launch counts at full precision.
JSON retains that precision for `starts_per_hour` and `hours_queued`. Text rounds estimated durations for display.

## Which producer earns its slots?

The launch-based `phm fleet yield` and `phm jobs yield` reports credit a
merge to the launch that published the PR URL named by the outcome receipt.
A reconciler receipt that repeats the publish event preserves an existing
claim for that URL. If the outcome URL has no matching claim, credit falls
back to the latest launch with a PR claim, then the latest launch. A later
revert replaces the merge credit in subsequent reports.

Run `phm jobs yield --by source` for a scoreboard per producer over the last 24 hours (`--since 7d` for a week). Each row
has launches, PRs opened, merged, empty, aborted, merged per launch and median minutes to merge; the lowest merged per
launch comes first, under one plain verdict line such as "filler: 2 merged of 40 launches, consider stopping it". A job's
source is its `src=` tag on the queue line, else its id prefix: `leader` (ids ending `N<day><letter>Q8`), `core`
(`RQ-PHX-`), `cl-stream` (`RQ-CL-`), `guardian` (`FIXUP-`), `filler` (one-test ids such as `RQ-MD3A111800Q8`), or `other`.
`--by lane` ranks lanes the same way; `--by family` is the per-job-kind view with keep, watch and stop verdicts, which is
also the default. `--json` returns `jobs.yield-by.v1`. A median that cannot be worked out is `null`, shown as unknown. A
source needs 5 launches before it is judged. The hourly digest adds a `yield_low` line carrying the worst source.

## Waiting to launch

Run `phm queue stuck --json` to list READY router jobs without a recorded launch. `age_s` uses the enqueue epoch, or the first timestamped dispatch event for the job; `age: "unknown"` means neither is available. If dispatch events are unavailable, `eventsAvailable` is false and the list may include jobs that have launched. The desktop Queue view shows the same reading. The dispatch-events log is append-only and unbounded, so it is folded line by line: memory stays flat however large the log grows, and every event still counts.

### Retry empty jobs

Run `phm jobs retry-empty --dry-run` to preview READY lines for empty jobs from
 the last 24 hours whose notes or logs identify an overly broad task or slow or
 timed-out tests. Run `phm jobs retry-empty --apply` to append the same kind of
 lines to the router queue. `--json` returns the planned lines for agents;
 `--file <path>` selects a queue file. Each retry keeps the original repo and
 route and asks for one independently shippable part. Jobs without one
 unambiguous original queue line are skipped, as are duplicates and work
 already done. The queue directory's `empty-retry-receipts` records each retry
 permanently, including if the queue line is later removed. Keep that directory
 when moving the queue. A crash between recording a receipt and writing the
 queue can leave a job unqueued; inspect the queue before manual recovery.

## Coalesce small jobs into batches

Run `phm queue coalesce <file>` (or pipe queue lines on stdin) to merge small
READY lines for the same repo into batch jobs, so one session takes several
related tasks instead of one launch slot each. Lines join a batch only when
they share repo, pool and tier and declare `size<=200` or less; a batch holds
at most 8 tasks and the rest form the next batch. A batch id is derived from
its member ids, and each batch lists the ids it replaces. P0 lines,
`tier=frontier` lines, FIXUP ids, `src=leader` lines and lone lines stay as
they are. Malformed READY lines stay as they are and are reported.

Each batch also has a prompt: a numbered checklist of the tasks with their
acceptance, then fixed rules (skip a task that is already covered and say so,
ship the finished subset, end with no changes only when every task is already
covered, run only the touched tests).

The default is a dry run: one plain line per batch, or `--json` for the
`phantom.queue-coalesce.v1` report. `--apply --out <directory>` first saves
`router-queue.original.md`, then writes `router-queue.md` and
`prompts/<batch id>.md` there. It never replaces existing files and never
edits the input queue.

## Steer the queue

Run `phm queue` to list the queued jobs in the order they launch: position, id,
repo, lane, tier, age and, when a newer cycle of the same job is queued, the id
that replaces it. `phm queue --json` returns the same list as the `launch` field
(schema `queue.order.v1`, `version` 1) beside the batch report.

Three actions change one queued job. Each takes `--dry-run`, which prints the
change and writes nothing, and `--json` (schema `queue.action.v1`):

- `phm queue top <id>` moves the job to the front.
- `phm queue lane <id> <lane>` moves it to another lane. Held and unknown lanes are refused. The row's lane column and its requirements cell's `preferred_lane` move together — the market prefers the spec hint, so a column-only rewrite would leave the job on its old lane.
- `phm queue drop <id>` takes it out. The row is copied to `queue/dropped.tsv` and its router line is marked `DROPPED`.

Every write holds `queue/ready.lock`, edits a fresh read of `queue/ready.tsv` and
keeps the earlier text in `queue/ready.tsv.bak`. If the dispatcher was in the
middle of a run and wrote the old queue back, the command says so and exits 1;
run it again. The Queue pane in the desktop app uses the same calls through
`GET` and `POST /api/verse/fleet/queue/order`.

## Batch session results

Run `phm queue batches` to see one plain summary of batch sessions, or
`phm queue batches --json` for the typed `phantom.queue-batches.v1` report.
`phm queue --json` also returns this report. Use `--runs <directory>` with
`batches` to inspect a fixture or another local runs directory.
This is read-only. The same report backs both forms.

The report also carries `routeSkips`: ready jobs whose prompt needs something
their lane is declared unable to do, each with the typed code
`route_skip: lane lacks gh` and one plain sentence. The human form adds one
line only when such jobs exist. It is a forecast from `queue/ready.tsv` and
`queue/prompts`; it moves nothing. Unreadable files report `unknown`, never an
empty all-clear. See [lane capability fit](ROUTING.md#lane-capability-fit).

`emptyPrefixes` reports the top five job-ID prefixes by empty `finish` rows in
the last 24 hours, with counts and a total. Retries count separately; filler
counters and trailing incident hashes are removed while lane names remain.
No-op outcomes before launch do not inflate this count. Missing, unreadable or
oversized (over 16 MiB) metrics have `evidence: "unknown"` and `total: null`;
malformed or unmeasured rows give partial counts and `malformedLines`.
Restock records `DONE-NOOP` before admission for explicit merged/recently closed
PR targets and exact filler requests with merge evidence. Unknown evidence
keeps work eligible. Host-only generators still require their own prechecks.

The dispatcher already groups related READY lines in one repository into bounded
sessions. `batch-sessions.json` sets `max_lines` (up to 10); every line retains its
own lease, worktree, subagent, tests and PR through the normal guarded publisher.
Failed lines retry individually. See [batch operation](../contrib/mac/README.md#adaptive-concurrency-and-batching)
for configuration and exclusions.

Each report session has `id`, `repo`, `area` and one `outcomes` entry per member:
`job`, `outcome` (`pr`, `empty`, `failed`, `unknown`), `pr`, `reason` and
`autoMerge` (`armed`, `off`, `unknown`). Checklist reasons persist in the batch
manifest and task outcome journal. A worker's `done` alone never proves a PR.
PRs and empty results require the matching per-line publisher handoff and a
receipt newer than the session; `AUTO_MERGE on|off` supplies auto-merge evidence.
Reasons are scrubbed before display. The report never returns worker prompts.

Gaps: local receipts do not verify current GitHub state. Missing, stale or
unreadable receipts remain unknown. Unavailable manifests return `totals: null`;
invalid manifests or more than 1000 files mark the report partial, with counts
only for readable sessions. Old sessions whose handoff markers were superseded
may have unknown publication results. These changes require Security review and
re-pinning before dispatcher installation; no live cutover is part of this change.

### Queue health

Run `phm fleet parked --json` for the read-only `health` summary
(`fleet.queue-health.v1`). It separates ready and parked counts and groups
repeated precheck skips, including `RESTOCK`, by job, code and reason over the
last 24 hours. A READY row's lane hint resolves like `work_market.requirements`:
the requirements JSON's `preferred_lane` wins over the lane cell and explicit
`null` is lane-open, while an absent key falls back to the lane cell. A row
carrying no requirements cell resolves its spec from the matching
`queue/router-queue.md` `(attrs)` envelope instead: the envelope's
`preferred_lane`, `lane` or `pool` attr is the hint and the lane cell is
never consulted, an envelope naming no lane attr is lane-open, and a
malformed envelope — like a lane cell the market rejects, which fails the
row before the envelope is read — is `invalid_requirements`. With no
matching envelope the lane cell stands. Rows the market resolves to no lane —
explicit `preferred_lane: null`, an envelope naming no lane attr, or no
spec preference with an empty lane cell — are the market's open
hint: they count in `ready`/`total`/`unhinted` and in the health ready count,
but stay unattributed in `byLane` and `nextUp`. A row the market rejects
(`invalid_requirements`: malformed spec, invalid `preferred_lane` or lane cell)
is dead work — counted in `malformed`, never open supply. A repeat means at
least two matching records; it does not prove
a job is still blocked. `phm fleet ready-supply` reports the same lane-open
rows as `unhinted` (`total`, `phantom`, `filler` split by the `RQ-PHX-` id
rule): supply the market can place on any lane, which the planner counts
toward its supply floor. The plain-text command shows the same repeat counts.
Counts cover the bounded readable queue and log snapshot, before display
limits; check `sources` for missing or degraded evidence. Unavailable health
counts are `null`; a readable empty source counts as zero. Lane filters omit
unattributed repeat details; health counts remain global. Nothing is unparked,
restocked or changed by reading the report.

## Why a PR is waiting

Run `phm queue wait --json` for the oldest recorded queued PR and its current wait
reason. Omit `--json` for plain words. It reads the local merge-event ledger;
`--events <file>` selects another [merge-event ledger](FLEET-MERGE-LATENCY.md).
The typed `queue.wait.v1` report contains `state` (`queued`, `empty`, `unknown`)
and `oldestQueued` (repo, PR number, enqueue time, seconds waiting, reason and
reason start time), or null. Merged and closed PRs have no current wait. Missing,
invalid or repeated enqueue evidence leaves the oldest unknown; conflicting
blocker observations leave the reason unknown. Exit codes: 0 known, 1 unknown,
2 invalid arguments. This reads recorded evidence, not live GitHub state, and
does not populate the ledger. Required checks and merge-queue rules stay enforced.
