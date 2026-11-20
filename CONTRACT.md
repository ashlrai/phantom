# Phantom Bots

`agents/phantom-bot.ts` exports `phantomBotSchema`, `PhantomBot` and
`parsePhantomBot(value)` for strict provider-neutral `phantom-bot.v1` metadata.
`lanePolicy` uses queue requirements, rejects metered cost and lane/provider pins,
and defaults max cost to included. `listPhantomBots(home?)`,
`readPhantomBot(id, home?)`, `planPhantomBot(value, home?)` are read-only;
planning refuses existing ids. `writePhantomBot(value, home?)` exclusively creates
a private record. `explainPhantomBot(bot, runs?, now?)` returns primitives,
strict master-router eligibility, primary decision, fallback plan, rejected lanes
with master reason codes and posture evidence; no model calls, dispatch or writes.
`cli/bots.ts::runBotsCli(argv, out?, home?)` returns 0 on success, 1 on error/refusal.
Creation requires `--dry-run` and never calls the writer.

## External bot seats

`src/core/bots/seats.ts` exports `BotSeat`, `QuotaEvidence`, `SeatAdapter`,
`SeatState`, `SeatHandoff` and `SeatOptions`. The strict on-disk roster schema is
`phantom-bot-seats.v1` at `~/.phantom/bots/seats.json`; missing means empty.
Kinds are devin-bot, grok-bot, openai-bot, local and other; other requires a bus
provider, all others derive it. Secret handles are names only; secret-shaped
metadata is rejected. Unknown quota has no numeric usage value.

Exports:
- `transitionSeatState(prev: SeatState, state: SeatState['state'], now: string): SeatState`
  enforces active to draining to idle to active; invalid edges throw.
- `nextSeatState(prev, {quota, openWork, now}): SeatState` is pure. Fresh measured
  evidence below 100, newer than idle time and after any recorded exhausted
  reset, permits reactivation. Unknown evidence does not change state.
- `advisorySeatAdapter(seat: BotSeat, usage: () => Promise<QuotaEvidence>): SeatAdapter`
  is inert; local is loopback-only.
- `listSeats(opts?: SeatOptions)` returns `{schema:'phantom-bot-seats.v1', seats}`.
  Each row includes provider, bus-v2 participant, state, acceptsNewWork, quota,
  claims, inFlight, recent handoffs and advisory adapter status. Only lifecycle
  transitions may persist during listing; missing node stores stay missing.
  Open work counts live coordination claims owned by `participantId` or by any
  other label of the same registered bus identity; an unreadable identity
  registry keeps exact-label matching.
- `seatMayClaim(id: string, opts?): Promise<boolean>` accepts only active seats
  with measured quota. The module acquires no claims.
- `seatParticipants(opts?): Promise<Participant[]>` projects poll participants;
  draining/idle map to idle. `phm agents bus id list` adds these as `participants`
  without modifying stored identities, channels or authority.
- `planSeatHandoff(id: string, opts?)` is a dry-run projection; active seats are
  refused. `applySeatHandoff(id, opts?)` uses a stale-safe lock, fsyncs one
  `phantom-bot-handoff.v1` record per work/lease identity before releasing work,
  retries held releases on replay, declines node sessions and releases bus
  claims by source. Source releases require the current owner; seat handoffs also
  match the captured stored lease generation. Team and board clears use owner-only
  fencing because acquisition may normalize the requested expiry. It returns
  `phantom-bot-handoff-plan.v1` with `apply`, state
  and handoffs; apply handoffs include `notifications: {bus, owner}` statuses.
  Durable notice receipts suppress repeated attempts; crashes before receipt
  persistence retry with stable deduplication keys. Notification exceptions are
  value-free statuses, not post-release exceptions.
- `sendSeatMessage({from, to, text}, opts?)` delegates configured participants to
  unified bus DMs under the seat's fleet root and clock, or owner notices;
  unknown seats/secret-shaped text are refused.

`SeatOptions` injects home, runs, clock, quota reader, node store, node-release
port, owner-thread options, owner notice and bus post. Default coordination and
node storage use canonical roots; owner defaults on apply use the same fixed
settings/runs construction as the comms CLI and retain KILL/pause checks.
Injected homes relocate storage for hermetic tests. Public handoff metadata
uses unknown/null when evidence is unavailable; tokens are never serialized.

`src/core/bots/devin-bot-adapter.ts` exports:
- `devinQuota(read?: () => Promise<DevinUsageResult>): Promise<QuotaEvidence>`
  maps the existing documented org-cycle consumption reader without guessing.
- `createDevinBotAdapter(options?: {secretHandle?: string; readUsage?: () => Promise<QuotaEvidence>}): SeatAdapter`
  exposes kind, message, status and usage. Status is unknown and messaging is
  advisory (`no-documented-bot-messaging-api`); default messaging never makes a
  network call. Missing/exhausted evidence refuses, and no evidence enables
  paid execution. Usage source is `devin-api-v3-org-cycle`, not per-Bot quota.

`GET /api/bots/seats` delegates to `listSeats()` through `handleBotTemplates`,
returns 503 with a value-free error if unavailable, and disallows mutation
methods. `/bots` consumes `botSeatsQuery` and renders accessible measured quota
meters, unknown evidence, claims/jobs and handoffs; there is no web apply route.
See [bot seats](docs/BOT-SEATS.md) for storage and API-gap boundaries.
# Codex model defaults

The source-owned Codex default is `gpt-6.2-sol` for work, mid, fast,
computer and generic selection; frontier selects `gpt-6.2-astra`.
`codexModelForTier` keeps this mapping independent of experimental Terra priors.
Explicit operator model pins and custom engine defaults still take precedence.
Legacy GPT-6/6.1 catalog identities remain available for exact fallback lookup.
The elite identity table recognizes the exact `gpt-6.2-sol` and
`gpt-6.2-astra` IDs for OpenAI engines; older model-specific grants do not
implicitly authorize either new version.
Batch `model_for(lane, tier, prompt, cfg)` keeps its signature and accepts optional
`models.codex.<tier>` overrides above `models.codex.default`. Legacy loaded configs
with only a Codex default retain that default for every tier. The issue router
keeps its separate Luna cheap slot. These defaults grant no provider access,
subscription allowance or spending authority.

# Managed desktop CLI upgrade

`src/core/desktop/consumer-upgrade.ts` exports `ConsumerUpgradeDependencies`
(the consumer install ports plus `smokeVersion` and lowering-only
`residentStop`), `ConsumerUpgradeOptions`, `ConsumerUpgradeResult`,
`createConsumerUpgradeDependencies`, `inspectConsumerDesktopUpgrade` and
`applyConsumerDesktopUpgrade`. Inspection returns frozen `desktop-upgrade.v1`
observations and stages verified paired public artifacts privately. Apply
consumes an invocation-owned admission once; it requires Stop/drain, stops the
resident, switches the managed CLI pointer atomically and keeps the old release.
`desktop-upgrade-journal.v1` records the previous/current release and version
for explicit rollback. Neither mode replaces the native app, grants authority,
or restarts the resident. `cmdDesktop` accepts optional upgrade dependencies as
its fifth parameter; `parseDesktopInstallArgs` preserves `{apply}` for plain
install and adds `mode`, `requireApp` and optional `to` for upgrade/rollback.
The install module also exports `ConsumerInstallHeld` for shared error
classification and the `directory`, `parents`, `owned`, `regular`, `write`,
`sha`, `ioRead` and `packageReady` guards.

# Lane allowance evidence

`src/core/usage/lane-allowance.ts` exports pure `projectLaneAllowance(inputs,
nowMs)` and read-only `readLaneAllowance({ runsDir?, weeklyFile?, nowMs? }?)`,
returning `LaneAllowanceSnapshot` (`v: 1`, `asOf`, `lanes`). Inputs combine
resource-live state/history, parsed posture evidence and published Devin weekly
capacity. Runs default to `ASHLR_RUNS_DIR` or `~/.ashlr-runs`; `weeklyFile`
overrides the Devin publication path. `LaneAllowanceInputs` and
`LaneAllowanceRow` describe nullable usage, reset, age, history, posture and
Devin preview evidence. Missing measurements stay null; stale values retain
their age and reason. Future observations have `freshness: invalid-future`,
null usage/age and an invalid-timestamp reason. A lane name alone never proves
cost. Fresh verified USD readings map to `api-credit`; included/metered receipt
classes require fresh matching provenance, and unrecognized classes stay unknown.
`GET /api/usage/lanes` returns this projection without refreshing providers.
`postureEvidence(root)` is exported from `src/core/queue/route-explain.ts` for
the shared bounded journal parser. It preserves receipt `ts` (epoch seconds or
ISO timestamp) as optional `observedAt`, plus lane `lane`, `account_id`, `model`,
`window_start` and `reset_at` as `lane`, `accountId`, `model`, `windowStart` and
`resetAt`. Absent optional fields remain absent, including `freePreview` and
`previewExpiresAt`; parsing does not establish freshness or grant free status.
The resource-live reading parser preserves optional `account_id`, `model` and
`window_start`; weekly capacity also accepts optional `account_id` and `model`.
`ClaudeAccountStatusResult` and `ClaudeAccountUsageResult` include nullable
`accountScope`, an organization-only SHA-256 scope (`claude:` plus 16 lowercase
hex digits) from validated opaque native status `orgId`, never email. Usage
requires matching before/after scopes. `ClaudeQuotaReadingV1.accountId` is optional;
malformed scopes reject the reading, while legacy unscoped files remain valid.
The official Claude weekly resource-live source and sanctioned budget readings
forward it as optional `account_id`, without a model (the window covers all models).
`SanctionedReading` and `BudgetEntry` accept optional `account_id`; refresh owns
and clears it on unscoped re-reads or estimates, never borrowing prior scope.
When weekly capacity supplies the usage, its own scope is required, never
borrowed from a different sidecar reading. Receipt evidence must match that lane/account/model and window
(reset or fixed expiry, and window start when present), be within the reading's
15-minute freshness bound, and never be future-dated. Legacy unscoped receipts
remain readable in route explanations but cannot establish allowance posture
or cost; incomplete usage cannot establish posture.

A free preview requires a verified `devin-cli-models-list` models reading with
a positive count, a named Flash/Lightning model, a nonempty account matching
the lane reading, a fresh non-future observation and an unexpired preview window.
Receipt flags alone cannot grant it or extend the fixed preview deadline.
Granted previews include `evidence: { observedAt, accountId, model }` so cards
can age them out. Cards omit usage bars for missing usage and free countdowns
for unproven previews; future measurements show clock skew, not zero age.

# CI baseline evidence

Failure groups add `runs: {pr: number, head: string, runId: number}[]`, linking
only the failed job evidence to its workflow run and current PR head.
`src/core/fleet/ci-rerun.ts` exports `CiRerunOptions` and
`runCiRerunMaintenance(opts)`: injectable repositories, cancellation, GitHub,
analyzer, clock, authority/KILL readers, queue and journal/status paths. Only
probable flakes are rerun, with durable pre-attempt deduplication and a global
hourly cap (default ten). Rerun attempt rows carry the failing test id (bounded
to 400 chars). Successful rerun calls are later resolved to `verdict` journal
rows (`pass`/`fail`/`inconclusive`) by reading the workflow run once it has
settled: attempts younger than five minutes are not trusted yet, unresolved
attempts older than 24 hours stop being polled, and each pass checks at most
eight pending reruns per repository. `success` maps to `pass`, `failure` and
`timed_out` to `fail`, other completed conclusions to `inconclusive`; runs
still in progress or reads predating the rerun call stay pending.
`src/core/fleet/ci-flakes.ts` exports `recurringFlakes(rows, opts?)`,
`flakeJobId(repo, test)` and `enqueueFlakeFixes(flakes, absoluteQueuePath)`:
a test probable-flaking on at least three distinct heads within seven days
becomes one `RQ-CIFLAKE-*` work-tier queue row per (repository, test), capped
at ten new rows per run; each flake also carries `verdicts` tallies of recorded
rerun outcomes inside the window and the brief names them when present.
`src/core/fleet/ci-fix-generations.ts` exports
`nextFixGeneration(queueText, baseJobId, opts?)` and `MAX_FIX_GENERATIONS`:
queue deduplication is generation-aware — open rows suppress queueing,
dropped/retired rows and unparsed mentions stay suppressed, and a family
whose generations all reached DONE re-queues as the next `-G<n>` id (cap
three) while fresh evidence persists. Shared-baseline and recurring-flake
queueing both require effective authority and inactive KILL. Cancellation
returns/persists `status: 'aborted'`.
`ciRerunPaths()` resolves journal/status files under the ASHLR state root;
`readCiReruns(path?, nowMs?)` returns bounded entries, recent entries, counts,
lastHour attempts, recurringFlakes and `verdicts` (`pass`/`fail`/`inconclusive`
tallies, `pending` unresolved fired reruns inside 24 hours, and
`resolutionRate` = pass/(pass+fail) or null when none resolved);
`readCiRerunStatus(path?)` returns the persisted status or null, whose per-repo
records gain `recurringFlakes`, `flakeFixesQueued`, `verdictsPending` and
`verdictsResolved` counts.
Top-level config `ciRerun` accepts enabled, intervalMinutes, repos and maxPerHour.
Resident off-tick ticks launch it only with repositories and an elapsed interval.
The CLI `ci reruns [--json]` reads recent journal entries, counts,
recurringFlakes and verdicts without mutation.

`src/core/fleet/ci-baseline.ts` exports `analyzeCiBaseline(repo, gh?)`, a
read-only version 1 evidence report, and `parseBaselineFailures(log)` for capped,
scrubbed Vitest failure identities (test-level `file > name` and suite-load
`file > (suite)`) and summaries. `enqueueBaselineFixes(report,
absoluteQueuePath)` explicitly writes work-tier master-fix rows deduplicated
by queue state via `nextFixGeneration`: a failure whose prior fix generations
all reached DONE re-queues as the next `RQ-CIBASE-*-G<n>` id while the
failure is still observed on current evidence.
`applyBaselineUpdates(report, gh?)` explicitly applies expected-head guarded
updates only after current master test-pass and merged-fix ancestry evidence.
Unknown evidence never authorizes mutation. See [CI baseline](docs/CI-BASELINE.md).
# Frontier CLI discovery and daemon health

## Router catalog refresh

`DailyJobSpec` in `src/core/steward/schedule.ts` accepts optional `weekday`
(0=Sunday through 6=Saturday). When absent, daily unit output is unchanged.
When set, launchd receives Weekday and systemd receives a weekday-qualified
OnCalendar expression and Weekly timer description. Invalid weekdays throw.

`src/core/routing/catalog-refresh.ts` exports pure `diffCatalog(current,
sources, patterns, now, dryRun?)`, returning `{report, data}`, deterministic
`renderCatalog(data)` and `catalogPatch(before, after)`, and async
`refreshCatalog(options?, deps?)`. Refresh writes versioned report/patch
artifacts; only explicit apply writes the generated data file. Source runners,
fetch, seat discovery, current data and time are injectable. Source failures
are unknown; existing tiers and catalog entries are never removed or changed.
Only lite/normal pattern tiers may be assigned to additions. Reports use schema
`router.catalog-refresh.v1`.

`src/core/run/tool-path.ts` exports `resolveExecutable(name, {pathValue?, home?,
execPath?}?)`, returning `{path: string, source: 'path' | 'well-known'} | null`.
It rejects empty names and names containing `/`, searches PATH before common
tool directories, `~/.npm-global/bin`, and the Node executable directory, and
uses file metadata only (regular file with any execute bit). Options default to
process PATH, HOME, and execPath. Returned paths are absolute. Engine discovery
and absolute spawn-path resolution retain `which`/`where` first, then use this
fallback; this does not change service PATH or admission policy.

`src/core/daemon/guard-health.ts` exports `diagnoseFrontierClients(inventory,
lookup?)`; the injected lookup now returns the executable resolution above or
null rather than a boolean. Unavailable diagnoses retain `binaryOnPath` and add
nullable `binaryPath`, nullable `binarySource`, and `cause`: `binary-not-found`,
`auth-or-seat-not-admitted`, `policy-refused`, `resource-unavailable`,
`not-selected`, `non-loopback-refused`, `probe-timeout`, or `unavailable`.
Policy/resource/selection/refusal inventory reasons take precedence over binary
absence. Admission is inferred, never authenticated by this metadata lookup.
The health CLI bounds inventory discovery to 30 seconds; a timeout supplies a
sanitized frontier error and null resolved inventory, preserving unknown health
semantics and never itself recommending restart. See
[daemon revival](docs/DAEMON-REVIVE.md).

# Resident off-tick jobs

`buildBacklog` scans up to `BACKLOG_REPO_CONCURRENCY` (4) repositories at once,
aggregating scanner results in input repository order before existing ranking
and snapshot persistence. Each scanner has a 45-second sub-deadline, overridable
with `scannerDeadlineMs`. `signal` cancellation skips work not yet started.
`skippedScanners` records `scanner-deadline` and `phase-cancelled` skips alongside
unavailable observations. Skips are never cached as successful scans.

`createBacklogScanSnapshot()` creates a tick-local cache of in-flight remote gh
queries and scanner results. `buildBacklog({ snapshot, invalidate })` reuses
results except for `invalidate.repos` (all scanners) and `invalidate.scanners`
(all repos). Remote query promises survive scanner invalidation; ranking,
filters, proposal deduplication and persistence always run again. Without a
snapshot all reads are fresh. `runGhAsync`, `listIssuesAsync` and
`githubCiStatusAsync` are abortable, never-throw read APIs; synchronous GitHub
APIs retain their existing behavior. CI-only reads do not fetch PR/issue counts.

`SelfHealCycleResult.checkedRepos` lists repos whose detector ran or whose
self-heal queue projections were pruned during the cycle. Both cycle entry
points return an empty array on early exits. The cycle budget is two minutes;
the per-repo budget remains two minutes and the cursor resumes deferred work.
Post-self-heal tick refreshes invalidate these repos plus queued-autonomy for
every repo; a missing result conservatively invalidates all enrolled repos.

Ancillary observation work shares `ANCILLARY_OBSERVATION_BUDGET_MS` (60 seconds).
`runCounterfactualReplay`, `scanRealWorldOutcomes` and `sweepRejectionLearning`
accept optional `signal`, `deadlineAtMs` and `now` controls. Calls without these
controls retain their existing behavior. Interrupted replay does not persist
partial calibration; outcome/learning results mark `sourceComplete: false` and
include `skippedReason`. Outcome windows preserve their cursor on interruption.
Daemon state persists optional `counterfactualReplayPending` to retry interrupted
replay on the next eligible tick rather than waiting for its normal cadence.
The budget audits skips but drains active work cooperatively; credit release,
reflection and regression monitoring are not governed by this sub-budget.

`runTickPhase` accepts `detached?: boolean`: detached phases retain deadline,
abort and grace semantics but do not consume the tick budget, update progress,
or append to its ledger. `recordTickPhase(record)` appends metadata to an open
ledger. `DaemonTickPhaseStatus` includes `off-tick`, excluded from tick outcomes;
`DaemonTickPhase.offTick` carries run identity and previous settled metadata.
`launchOffTickJob(name, run, opts)` synchronously records an off-tick launch or
existing run. Jobs are single-flight until both bounded and inner work settle.
`offTickJobsSnapshot()` returns metadata only; `cancelOffTickJobs(graceMs?)`
aborts running jobs and bounds shutdown waiting.
Resident non-once ticks enable `offTickMaintenance` (ignored for dry runs):
self-heal and ancillary run single-flight in the background, and auto-merge
precedes backlog refresh. Direct and once ticks retain in-tick maintenance.

# Advisory routing pairing

`routing/decision-schema.ts` exports `routeFailureKindSchema` (quota, 5xx,
timeout, near_reset). Strict `RouteRequest` accepts optional `job`, `needs`
(up to 32 capability names), `min_tier`, `max_cost_class`, `data_class` and
`fallback` (up to three unique strict `{lane,on}` pins). Old requests are unchanged.
`routeCandidateRejections(request,sources,nowMs,{failover?,pinned?}?)` returns
all exclusion reason codes for deduped sorted candidate lanes; empty means eligible.
`router/fallback.ts` exports `planFallbackChain`, `nextFailover`,
`recordFailover`, `readFallbackUsed` and `runFailover`. Plans are
`route.fallback.v1`, advisory, live:false, at most three entries, never primary.
`nextFailover` accepts failed_lane, failure and attempted, with an optional
fresh request/sources/nowMs recheck. Recording requires a job identifier and
appends sorted-key failover/refusal rows to metrics/jobs.jsonl without task text.
History reads only the bounded 256 KiB regular-file tail, newest last, max three
matching rows or null. `explainRoutes` adds nullable `fallback_chain` (non-fusion
decisions only) and `fallback_used` (job receipts). See [gates and inert status](docs/ROUTING.md#failover-chains).

`router/outcomes.ts` exports `foldRouterOutcomes(text, {passkFor?, workClassFor?, revertedPrKeys?})`,
`authorityRevertedPrKeys(evidence)`, `foldSpendCosts(text)`,
`foldRouteDecisionWorkClasses(text)`, `readLedgerFile(path, limit?)`,
`readLedgerTail(path, maxBytes?)` and
`readRouterOutcomes({runsDir?, lane?, ashlarDir?, authorityEvidence?})`,
producing `router.outcome.v1` records folded from `metrics/jobs.jsonl`. The jobs
ledger is append-only and unbounded, so the read retains the newest
`ROUTER_OUTCOME_LEDGER_LIMIT` (16 MiB) bytes via `readLedgerTail`: an
oversized ledger reports `truncated: true` and folds only the retained
window — a lower bound on history, never a refused read or a claimed
total. `cost_usd` is an explicit `cost_usd`/`usd`/`cost` field on a jobs
row when present; otherwise it is the sum of `metrics/api-spend.jsonl`
call costs naming the job (`job`/`job_id`/`id`, same
`cost_usd`/`usd`/`cost` precedence the fleet spend readers use), read
under the same bound — spend rows without a job id are unattributable
and never counted, a job whose calls reported no cost stays `null`
(unknown, never zero), and `cost_estimated` rows still count because
they report a USD figure. The spend read degrades independently:
`RouterOutcomeRead.spend_state` reports its health and
`spend_truncated` marks a cut spend tail (joined costs are lower
bounds). `work_class` joins the same bound of
`metrics/work-market.jsonl`: `foldRouteDecisionWorkClasses` collapses
`work-market.v1` `route_decision` rows to each job's newest-timestamp
recorded class — the market's own classification, written for every
evaluated job — and the fold's `workClassFor` option fills only
outcomes whose jobs rows recorded no class, so an explicit
jobs-ledger `work_class` always wins and a job with no decision row
stays null. Rows with a missing or non-finite `ts`, an absent or
non-route-identifier `work_class`, or a wrong schema/event are
skipped. The market read degrades independently too:
`RouterOutcomeRead.market_state` reports its health and
`market_truncated` marks a cut tail; anything but `read` leaves
classes ledger-recorded only. `passk` is the
lane+model's pass^k (`passPowK`) from the published `eval.lane-scores.v1`
projection (`~/.ashlr/eval/passk/lane-scores.json`, `ASHLR_HOME` honored);
it is `null` whenever the ledger lacks lane/model, the projection is
missing or degraded, the pair is duplicated, or the row's own pass^k is
null — unknown stays null, never estimated. `RouterOutcomeRead.eval_state`
reports the projection health (`healthy`/`missing`/`degraded`) so callers
can distinguish absent eval evidence from a real score. `reverted` folds
explicit revert evidence — a `reverted` boolean, a revert event name or
terminal REVERT/REVERTED state field, or a parseable `reverted_at`/
`revertedAt` stamp — plus the authority ledger's verified evidence index:
`authorityRevertedPrKeys` resolves each `revert:landed` row's
`revertsLandingId` to its `merge:landed` landing and yields the merged
PR's `owner/repo#n` key, and the fold marks an outcome reverted when the
job's own canonical github.com pull URL claim is unambiguous and
canonicalizes to one of those keys (ambiguous, foreign or non-canonical
claims never mark). `readRouterOutcomes` reads that index lazily through
`ledgerSnapshot('cached')` — only hash-verified rows contribute, a broken
chain still marks only its verified prefix, and any read failure degrades
to no join; `authorityEvidence: null` skips the join and an explicit
array is used as given. Revert evidence is sticky-true like
metrics-ingest, so a recorded revert is never contradicted by a later
`reverted:false`; it is `null` when neither source records anything
either way. The fold is read-only and advisory: it
never routes, ranks, tunes or writes.

`explainRoutes(root, nowSeconds)` returns nullable `posture` from the bounded
256 KiB tail of `metrics/work-market.jsonl` (regular files only, no symlink
following). Its `lanes` map contains `posture`, `postureReason`, nullable
`projectedUnusedPct` and nullable `hoursToReset`. The newest `work-market.v1`
posture event wins, falling back to the newest route decision's ranking inputs
only when no posture event exists. Missing or invalid evidence returns null.
Lane evidence may also include `costClass`, `costClassReason`, `zeroCost`, and
`allowance` with nullable numeric `used`, `limit`, `in_flight`, `reserve`,
`session_cap` and `headroom` ACUs, projected from `work-market.v1` receipts.
Devin's effective class is `included` only within measured weekly allowance
after reservations and reserve with room for one session, or for an unexpired
selected Lightning/Flash free preview (`zeroCost: true`); otherwise `metered`.
Unknown usage stays null. See [queue cost evidence](docs/QUEUE.md#resource-posture-the-lane-is-a-hint).

`run/model-mode-data.ts` owns `ModeTier = lite|normal|ultra|fusion`, the exact
model classifications and their capability order. `ModelEntry.modeTier` is
required and excludes fusion (a composition). `RouteRequest.mode?` requests a
minimum model class, independently of queue `tier_hint`; unknown models need
`models.json["mode.<model>"]`. `RouteDecision.mode_tier` is the selected class
or null. `RouteReport` includes `requested_mode` and nullable capacity evidence.
`decideRoute(raw, sources, {backends?, signal?, nowMs?})` returns a
`RouteReport` or, for fusion, `route.pairing.v1` with `mode_tier: fusion`.
Fusion assigns ultra judgment and lite/normal implementation through
`decidePairing`. Assignments add nullable `model` and `mode_tier`.
`RouteSources` adds optional `capacity` and `request` snapshots, loaded from
`queue/route-capacity.json` and `queue/route-request.json`. `explainRoutes`
adds nullable `decision`, recomputed without model calls from those snapshots.
Among eligible lanes: closest future reset with positive allowance, then
zero marginal cost, then cheapest known marginal cost; unknown cost sorts last.
`ResetCalendarPool.costPerMTok?` is nonnegative marginal USD/M tokens, not
subscription sticker price. Reset-calendar lanes now sort by reset before pace.
`ResetCalendarPool.burnPerHour?` is the measured window percent per hour. With it,
`runway()` (`src/core/usage/runway.ts`, pure) puts the pool in `spend`, `pace`,
`starve` or `unknown`. `rankRouteCandidates(request, candidates, nowMs, familyYield?)`
drops `starve` lanes for non-frontier work unless the job kind's merged-per-launch
in `RouteSources.familyYield` is at least `JOB_KEEP_RATE`. It ranks `spend` lanes
first for non-frontier work. `routeCandidateRejections` adds `runway_starve`.
`readPoolRunway()` (`runway-read.ts`) returns `pool.runway.v1` for
`phm pool runway --json` and `GET /api/usage/runway`.
`planPoolShares(inputs)` (same file, pure) maps each pool's used percent, burn
percent per hour and hours to reset to `{pool, runway_hours, hours_to_reset,
used_percent, projected_percent_at_reset, state, suggested_share, rank, reason,
line}`; `state` is `starving` (runway under 80% of hours to reset), `wasting`
(projected use at reset under 90%), `on_pace`, or `unknown` (any input missing
or reset passed). `PaceSnapshot.shares` (`src/core/usage/pace.ts`) carries it as
`fleet.pools.v1` in `GET /api/verse/usage-resources` and `phm fleet pools --json`.

`decidePairing(lanes, nowMs, { bottleneck? })` in `src/core/routing/pairing.ts`
is pure and returns `route.pairing.v1` with `advisory: true`, nullable lead and
sidekick assignments, and closed `PairingReason` codes. Judgment stays frontier;
implementation escalates only for an explicit implementation bottleneck.
`explainRoutes(root, nowSeconds)` adds nullable `pairing` from the optional
`queue/pairing-lanes.json` evidence. See [routing](docs/ROUTING.md#advisory-leadsidekick-pairing).

# Phantom — shared core contract (M1/M2 baseline)

Resource-live sources accept optional `usage.liveSources` configuration (see
[resource evidence](docs/RESOURCE-EVIDENCE.md#publish-subscription-capacity)).
`ResourceLiveReading.confidence` is `high | medium | low | null`, derived from
the source tier; old sidecars without it remain readable. Observations may
carry `stale_after`, which can shorten but never extend the 15-minute TTL.
`DaemonCapacityPublisherDeps.refreshResourceLive?(cfg)` refreshes the rail after
a publisher cycle; production wiring is daemon-only and disabled in tests.
`OperatorUsagePageReader.read(provider, usageUrl)` returns a nullable observation;
the shipped implementation always returns null and is opt-in only.

This is the binding interface for Phantom's original index, launcher and
identity modules (the package was formerly named ashlr-hub). Do not change these
exported signatures without updating this file. Later milestones pin their own
contracts in `docs/contracts/`. All source is ESM/NodeNext:
**import sibling modules with `.js` extensions** (e.g.
`import { getGitStatus } from './git.js'`). Strict TypeScript.

The modules below use Node builtins only. The package as a whole declares a
small set of runtime dependencies in `package.json` (for example the MCP SDK,
`yaml`, `smol-toml`, `marked` and `tar`); do not add one without updating the
dependency contract and its verification together (see
[CONTRIBUTING.md](CONTRIBUTING.md)).

The canonical types live in **`src/core/types.ts`** — import them, never redefine.
Every module named below is implemented; the signatures are the required
baseline, and several have since gained optional trailing parameters (noted
inline).

The CLI ships as `phm` with the compatible `ashlr` alias (both run `bin/ashlr`).
The full, current command inventory is `phm help --all`.

## Headless ACP seats

`agents/acp-client.ts` exports `runAcpSeatTurn(opts: AcpSeatOptions,
deps?: AcpSeatDeps): Promise<AcpSeatResult>`. Options provide command, args,
cwd, prompt, exact model, async-capable qualifyModel, timeoutMs, optional signal
and permission (`read-only` by default, or `allow`). Dependencies inject spawn
and env. Results contain ok, code, text and optional message, sessionId and
stopReason. Qualification fails closed before spawning, with no paid fallback.
ACP config model selection defaults to exact values. Optional `planModelStep`
has signature `(target: string, configOptions: unknown): AcpModelStep`, returning
`{kind: 'set', configId, value}`, `{kind: 'done'}` or
`{kind: 'unplannable', reason}`. Each set replans from the response configOptions;
unplannable targets or more than four sets fail before prompting, without fallback.
No model control leaves selection to the agent's launch arguments.
Input lines and collected text are capped at 1 MiB each; stderr is discarded.
Timeout and abort notify session/cancel and terminate the child.

`devin/acp-seat.ts` exports `devinAcpSeatArgs(model): string[]`,
`devinQualifiedFreeModel(catalog: DevinModelCatalog, model: string, nowMs?: number): boolean`
and `runDevinAcpSeat(opts, deps?): Promise<AcpSeatResult>`. Wrapper options replace
command/args/qualifyModel/planModelStep with cliPath and catalog. The wrapper
uses nextDevinModelStep for family, effort and speed selection. Only exact free
ids from a native (`cli`) catalog with a parseable fetchedAt no older than
DEVIN_MODELS_MAX_AGE_MS and not in the future qualify (nowMs defaults to Date.now()).
Cache, fallback, aliases and lightning do not qualify.

## Bounded peer work dispatch (RQ-AGENTNET-DISPATCH-1)

`agents/bus-v2-schema.ts` retains `agent-bus.v2` and adds optional
`work.post.dispatch: {tier: fast|mid|work|frontier, scope, acceptance}` (4000/2000
character caps), and `work.result: {jobId, claimKey, queueId, receiptId, outcome,
reason?}`. Outcomes are `reserved|admitted|complete|failed`; reasons are bounded
codes. Queue/receipt IDs are `peer-work-<32 hex>` / `pw-<32 hex>`.
Existing work posts remain coordination-only without a dispatch payload.

`agentnet/work-dispatch.ts` exports
`consumePeerWork(session: PeerSession, input?: {apply?: boolean; after?: number},
options?: PeerBusOptions)`. The host-owned private `dispatch.json` beside peer
bindings supplies enabled state, peer allowlist, repository allowlist, tier ceilings
and exact permitted paths. See [Agent Bus dispatch](docs/AGENT-BUS.md#bounded-peer-dispatch).
Results contain status, dryRun, bounded results, and a cursor on success.
Only authenticated admission receipts qualify; labels and peer status messages
cannot authorize claims or prove completion. `readPeerInbox` admits a
`work.result` envelope only when the private journal proves this host published
that exact outcome body to the caller's callsign (latest sent outcome per
receipt) and reports `workResults: missing|available|unavailable`. No shell,
engine, merge or spending is invoked. Queue task strings remain untrusted data
under existing worker gates.

`QueueJob` (RQ-SHARED-QUEUE-1) carries the optional market requirements
`max_tier` (tier ceiling; `tier` and `min_tier` may not exceed it), `data_class`
(`public|internal|confidential|restricted`) and `work_class`
(`bulk|standard|judgment`) beside `preferred_lane`, `needs`, `min_tier`,
`max_cost_class`, `exclusive` and `impact`; `validateQueue` refuses unknown
values, and `phm queue add` takes `--max-tier`, `--data-class` and
`--work-class`. `currentUnfed(statusJson, readyTsv, market?)`, `foldUnfedHistory(jsonl,
nowMs, windowHours)`, `foldMarketOverrides(jsonl, nowMs, windowHours)`,
`foldClaimOverrides(jsonl, nowMs, windowHours, truncated?)`,
`foldDecisionOutcomes(marketJsonl, jobsJsonl, nowMs, windowHours,
jobsTruncated?)` and
`renderUnfed(report)` in
`src/core/fleet/unfed-capacity.ts` and `src/core/fleet/unfed-market.ts` back
`phm fleet unfed` (`fleet.unfed.v1`). `foldMarketOverrides` collapses the
window's `route_decision` rows to each job's latest decision and tallies
`lane_override`s by reason and hinted-to-chosen lane; the report's
`overrides` field carries the counts (`available`, `decided`, `overridden`,
`byReason`, `lanes`). `foldClaimOverrides` tallies the window's jobs.jsonl
`claim`/`batch_claim` events — launches that actually left their hinted
lane, including `batch_session` moves decisions never record — into the
report's `claims` field (`available`, `truncated`, `claimed`, `overridden`,
`byReason`, `lanes`). `foldDecisionOutcomes` joins the same collapsed
latest-per-job decisions to the newest recorded outcome in the retained
jobs.jsonl tail through the router outcome fold, partitioning decided jobs
into `hinted`/`overridden`/`open`/`unrouted`/`unexplained` outcome tallies
(`decided`, `known`, `merged`, `unmerged`, `reverted`, `unresolved`) plus
`byReason` override-reason counts and per-`work_class` tallies in the
report's `decisionOutcomes` field (`available`, `jobsAvailable`,
`jobsTruncated`, `decided`); a missing jobs ledger leaves every decided
job `unresolved`, never a fabricated outcome. The optional `market` carries the
dispatcher's own input files (slots.json, models.json, budget-overrides.json,
adaptive.json, HOLD, router-queue.md); when slots.json parses, a derived
report recomputes per-lane `blocked` reason codes with the same eligibility
rules as `contrib/mac/work_market.py`, reported as `derivedReasons: true`.
Ready rows are validated exactly like `work_market.requirements` — a malformed
job id, tier or requirements spec (including a spec-less row whose
router-queue.md `(attrs)` envelope fails `from_envelope`) is rejected before
the market sees it, so it is counted in the report's `invalidRows` and left
out of `waiting`/unfed math like the dispatcher's `_waiting` set; on an
admission-stopped tick the dispatcher counts every JID+tier-valid row by its
raw lane column instead, and the derived report follows that relaxed set.
Reports also carry `fleetStop` (`admission_stopped` | `global_admission` | null): the
tick's fleet-wide stop in the dispatcher's own codes, read from status.json's
`paused`/`admission` verdict for a derived report (where it replaces the
per-lane codes) or back out of the published `blocked` codes for a
dispatcher one. Every report carries `statusAsOf` (status.json's `last_tick`
as ISO-8601, or null) and `statusFresh` (boolean, or null when no evaluation
clock was supplied): fresh requires a `dispatchd.status.v1` schema, a
parseable non-future `last_tick`, and an age within the same two-minute
window the spend projection uses; a stale or untimestamped snapshot is
reported as the last published state, flagged rather than hidden.

`QueueStore.claim(id, owner, intake?: {job: QueueJob; guard: () => void})` may
atomically insert a new READY job and claim it under the existing queue lock.
The optional synchronous host guard runs under that lock; an existing ID or an
invalid intake fails without mutation. The two-argument claim contract is unchanged.
`queue/decompose.ts` exports its existing `promptText(field, value, max): string`
validator for shared bounded, printable, secret-free queue prompt validation.

`PeerRequest.work` is a `work.post` or `work.status` body, accepted only for a
directed task; it becomes the authenticated bus body with the same enrollment
and audience checks. The send verifies the shared work feed first: a proposal's
provider must be named or resolvable through the sender callsign's registered
runtime and its job id must be unannounced; a status must name a job the feed
shows and only the job owner — by label or shared registered identity, the
projection's own rule — may move it. An unreadable feed refuses — so a peer
body cannot post the receipt that would poison the projection for every reader.
The CLI adds `phm agentnet peers post <to> <work-json>` and
`phm agentnet peers dispatch [--after <cursor>] [--apply] [--json]`.
Dispatch is a read-only preview unless apply is exactly true. Results use only
the local bus and its current comms/participant allowlist, never a Slack send.

Devin autoland (additive): `src/core/devin/autoland.ts` exports
`runDevinAutoland({apply, cap?}, deps?) -> Promise<DevinAutolandResult>` and
`setDevinAutolandPaused(paused)`. Results carry v:1, ok, mode, passId,
decisions and landed count; scanned decisions aggregate skipped-session counts
by not-ours/already-archived/not-finished. Decisions include reason and optional session,
bundle attachment, PR, job, commit count and auto-merge metadata. Dependencies
inject API, self identity, landing, command runner, clock, KILL and home.
Cap defaults to 3 (1–10); dry runs never persist. Apply decisions append to
autoland.jsonl. The client adds optional serviceUserId/isArchived and
archiveSession(orgId, sessionId), returning a validated DevinSession using
create retry policy. `autoland-timer.ts` exports ensureDevinAutolandTimer(deps?)
and stopDevinAutolandTimer(); resident passes are single-flight and unrefed.
The CLI adds `phm devin autoland [--apply] [--cap N] [--json]` and pause/resume.

Devin landing (additive): `src/core/devin/land.ts` exports
`landDevinSession(request: DevinLandRequest, deps?: DevinLandDeps): Promise<DevinLandResult>`
and its parsers; `DevinClient` gains `listSessionAttachments(orgId, sessionId)`
and `downloadAttachment(orgId, uuid, name, maxBytes)` (the key is never sent past
the API's redirect), and `DevinFetch` init gains optional `redirect: 'manual'`.
The CLI adds `phm devin land --session <id> [--repo <name>] [--base <b>] [--job <id>]
[--bundle <name>] [--apply] [--json]`, a dry run unless `--apply`; it runs the
pinned `publish.sh` unchanged and refuses repos outside its allowlist.

---

## src/core/types.ts — THE CONTRACT (types only)

The shapes below are the baseline fields. `AshlrConfig` has since gained many
optional sections (`firm`, `phantom`, `locus`, `genome`, `notify`, `foundry`,
`daemon`, `plugins`, `pulse`, `user`, `fleet`, `comms`, `reasoning`, `devin`),
and `models` / `telemetry` gained optional keys; read `src/core/types.ts` and
[`schema/config.schema.json`](schema/config.schema.json) for the full shape.

```ts
export interface TidyRule { match: string; matchType: 'glob' | 'regex' | 'ext'; dest: string; description?: string }

export interface AshlrConfig {
  version: number;
  roots: string[];
  editor: 'cursor' | 'vscode';
  staleDays: number;
  categories: Record<string, string>;
  tidyRules: TidyRule[];
  keepers: string[];
  models: { lmstudio: string; ollama: string; providerChain: string[] };
  telemetry: { pulse?: string };
  tools: Record<string, string>;
}

export type ItemKind = 'repo' | 'doc-folder' | 'doc' | 'asset' | 'symlink' | 'other';

export interface GitStatus { branch: string; dirty: number; ahead: number; behind: number; lastCommit: string | null }

export interface IndexedItem {
  id: string; name: string; path: string; kind: ItemKind;
  category: string | null; description: string | null;
  org: string | null; remote: string | null; language: string | null;
  lastModified: string; active: boolean;
  sizeBytes?: number; git?: GitStatus; linkTarget?: string;
}

export interface AshlrIndex { version: number; generatedAt: string; root: string; items: IndexedItem[] }

export interface TidyMove { from: string; to: string; rule: string }
export interface TidyPlan { moves: TidyMove[]; skipped: { path: string; reason: string }[] }
```

---

## src/core/config.ts — config + path constants

Responsibility: own `~/.ashlr/`, load/save config, provide defaults seeded from the real Desktop layout.

```ts
export const CONFIG_DIR: string;                 // ~/.ashlr
export const CONFIG_PATH: string;                // ~/.ashlr/config.json
export const INDEX_PATH: string;                 // ~/.ashlr/index.json
export function defaultConfig(): AshlrConfig;     // seed roots/categories/keepers/tidyRules, resolve tool paths
export function loadConfig(): AshlrConfig;        // read CONFIG_PATH; create dir + write default if missing
export function saveConfig(c: AshlrConfig): void; // write CONFIG_PATH (mkdir -p CONFIG_DIR)
```

Imports: `node:os`, `node:fs`, `node:path`, `./types.js`.

---

## src/core/git.ts — git introspection

Responsibility: read git state without third-party deps (shell out to `git` via `node:child_process`).
Must tolerate repos where `.git` is a **file** (worktrees/submodules), missing upstream, and zero-commit repos.

```ts
export function isRepo(dir: string): boolean;
// True if `dir` contains a `.git` entry (directory OR file).

export function getGitStatus(repoPath: string): GitStatus | null;
// Branch, dirty count (porcelain), ahead/behind vs upstream, last-commit ISO.
// Returns null if not a repo or git unavailable. A zero-commit repo returns
// its branch with lastCommit null.

export function getRemoteOrg(repoPath: string): { remote: string | null; org: string | null };
// Parse `origin` remote URL; extract org from ashlrai/*, masonwyatt23/*, evero-consulting/* style paths.
```

Imports: `node:child_process`, `node:fs`, `node:path`, `./types.js`.

---

## src/core/classify.ts — categorization + metadata

Responsibility: classify a path and extract cheap metadata. No git calls here (git.ts owns that).

```ts
export function categoryOf(path: string): string | null;
// Map an absolute path to a category by matching against cfg.categories folders / Desktop layout.
// NOTE: implementation may read config via loadConfig() OR accept it — keep signature path-only;
// resolve config internally.

export function describe(path: string): string | null;
// One-line description: README first H1, else package.json "description", else null.

export function primaryLanguage(path: string): string | null;
// Best-effort primary language (package.json => TS/JS, presence of go.mod, Cargo.toml, pyproject.toml, etc.).

export function kindOf(path: string): ItemKind;
// 'symlink' (lstat) > 'repo' (isRepo) > 'doc-folder'/'asset'/'doc'/'other' by name + dirent type.
```

Imports: `node:fs`, `node:path`, `./types.js`, `./git.js` (isRepo).

---

## src/core/index-engine.ts — scan + persist

Responsibility: walk roots (depth ~3), build IndexedItem[] using classify + git, persist/load index.json.
Must detect symlinks and NOT double-count symlink targets that point into `github/`.

```ts
export function buildIndex(cfg: AshlrConfig, opts?: BuildIndexOptions): AshlrIndex;
// Scan cfg.roots, classify each entry, attach GitStatus for repos, compute `active` from staleDays.

export function loadIndex(): AshlrIndex | null;   // read INDEX_PATH; null if absent/invalid
export function writeIndex(i: AshlrIndex): void;   // write INDEX_PATH (mkdir -p CONFIG_DIR)
```

Imports: `node:fs`, `node:path`, `./types.js`, `./config.js` (INDEX_PATH), `./classify.js`, `./git.js`.

---

## src/core/tidy.ts — loose-file tidy planner

Responsibility: plan and apply moves of loose top-level files per cfg.tidyRules. Honor `keepers` (never move),
skip symlinks, skip git repos, skip the indexed KEEPERS. Plan is always dry-run; apply is the only mutator.

```ts
export function planTidy(cfg: AshlrConfig): TidyPlan;
// Examine loose entries under roots; for each, first-matching tidyRule => TidyMove; else skipped w/ reason.

export function applyTidy(plan: TidyPlan): void;
// Execute plan.moves with fs.rename (mkdir -p dest). Idempotent/safe: skip if source gone or dest exists.
```

Imports: `node:fs`, `node:path`, `./types.js`.

---

## src/cli/open.ts — launchers

Responsibility: open a path in editor / Finder / Terminal. Best-effort, never throw on launch failure.

```ts
export function openInEditor(path: string, cfg: AshlrConfig): void;
// Build deep link from cfg.editor: cursor://file/<path> or vscode://file/<path>; `open` the URL.

export function openInFinder(path: string): void;   // `open <path>`
export function openInTerminal(path: string): void; // best-effort: open Terminal/tmux at path
```

Imports: `node:child_process`, `./../core/types.js`.

---

## src/cli/picker.ts — interactive selection

Responsibility: let the user choose one item. Use `fzf` ONLY if present on PATH; otherwise a
built-in `node:readline` numbered picker. **fzf is NOT installed by default — the builtin is the primary path.**

```ts
export function pick(items: IndexedItem[]): Promise<IndexedItem | null>;
// Resolve to the chosen item, or null if cancelled / empty input.
```

Imports: `node:child_process`, `node:readline`, `./../core/types.js`.

---

## src/cli/index.ts — CLI entrypoint

Responsibility: parse argv and dispatch. Invoked via `bin/ashlr` (installed as `phm`
and `ashlr`) -> `dist/cli/index.js`. No default export; runs on import (top-level).
The `switch (cmd)` in `main()` is the source of truth for top-level commands;
`src/cli/help.ts` (`HELP_ENTRIES`) and `src/cli/completions.ts` mirror it, and
`test/cli-registry-drift.test.ts` fails on drift. The baseline commands this
contract pins:

| command            | flags                | behavior |
| ------------------ | -------------------- | -------- |
| `index`            | `--refresh`          | build + writeIndex (force rebuild on --refresh) |
| `go [query]`       | `--open` \| `--cd`   | fuzzy-pick (or filter by query); --open in editor, --cd prints path for shell cd |
| `status`           |                      | summarize index: counts by kind/category, dirty/stale repos |
| `ls [category]`    |                      | list items, optionally filtered by category |
| `open <query>`     |                      | resolve query -> item -> openInEditor |
| `tidy`             | `--apply`            | planTidy (print); with --apply run applyTidy |
| `config`           | `get \| set \| path` | read/write config; `path` (or no subcommand) prints CONFIG_PATH |
| `help`             | `[<topic>] [--all]`  | topic-grouped usage; `--all` prints every command |

Imports: everything in `core/` + `cli/open.js` + `cli/picker.js`.

---

## src/raycast/* — Raycast extension (own package.json)

Lives in `src/raycast/`, excluded from the root tsconfig and eslint. Has its own `package.json`,
`tsconfig.json`, and Raycast dependencies. Reads the SAME `~/.ashlr/index.json` (do not re-scan in Raycast).

- `src/raycast/src/lib/index.ts` — load + parse `~/.ashlr/index.json` into `IndexedItem[]`
  (copy/share the `AshlrIndex`/`IndexedItem` types from `core/types.ts`).
- `src/raycast/src/lib/open.ts` — editor/Finder deep-link helpers mirroring `cli/open.ts`.
- Raycast command files (list view over IndexedItem, actions: open in editor, reveal in Finder, copy path).

Contract for the lib layer:

```ts
// src/raycast/src/lib/index.ts
export function loadIndex(): AshlrIndex | null;   // read ~/.ashlr/index.json
// src/raycast/src/lib/open.ts
export function openInEditor(path: string, editor: 'cursor' | 'vscode'): void;
export function openInFinder(path: string): void;
```

---

## M2 — identity & model awareness

M2 turns `~/.ashlr/config.json` into the unified source of truth and adds Phantom
Secrets identity (the separate `phantom` CLI) + local-model awareness. **Hard rules for every M2 build agent:**

- Zero runtime deps — Node builtins only (`node:child_process`, global `fetch`, `node:fs`, ...).
- **Probes NEVER throw.** Return a typed result with `up:false` / `error` on any failure.
- **Phantom is READ-ONLY and NEVER prints secret VALUES** — names/status only.
- doctor/providers MUST tolerate every endpoint being up OR down without crashing.
- `init` MUST be NON-TTY safe (no hang when piped / no stdin).
- Verify `phantom` subcommand flags at runtime via `phantom --help`; degrade gracefully.

### types.ts additions (already in THE CONTRACT)

```ts
export interface ProviderEndpoint { id: 'lmstudio' | 'ollama' | string; url: string; up: boolean; models: string[]; error?: string }
export interface ProviderRegistry { providers: ProviderEndpoint[]; activeProvider: string | null; chain: string[] }
export interface PhantomStatus { installed: boolean; version: string | null; initialized: boolean; secretNames: string[]; capability: PhantomCapabilitySnapshot; agentReport?: PhantomAgentReportRollup; error?: string }
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck { id: string; label: string; status: DoctorCheckStatus; detail: string; fix?: string }
export interface DoctorReport { generatedAt: string; checks: DoctorCheck[]; summary: { pass: number; warn: number; fail: number } }
// AshlrConfig also gains: phantom?: { enabled: boolean }   (models unchanged)
```

### src/core/providers.ts — local-model/provider registry + failover

Responsibility: probe local-model endpoints (LM Studio, Ollama), build a registry, resolve the
active provider via the configured chain. Pure probes; never throw.

```ts
export async function probeEndpoint(id: string, url: string): Promise<ProviderEndpoint>;
// fetch `url` (LM Studio: GET http://localhost:1234/v1/models -> data[].id;
// Ollama: GET http://localhost:11434/api/tags -> models[].name). On any error/timeout:
// { id, url, up:false, models:[], error }. On success: up:true with parsed model names.

export async function getProviderRegistry(cfg: AshlrConfig): Promise<ProviderRegistry>;
// Probe each provider implied by cfg.models (lmstudio/ollama) in cfg.models.providerChain order;
// chain = cfg.models.providerChain; activeProvider = first probed provider that is up, else null.

export async function resolveActiveProvider(cfg: AshlrConfig): Promise<string | null>;
// Convenience: id of the first up provider in chain order, or null when none are reachable.
```

Imports: global `fetch`, `./types.js`.

### src/core/phantom.ts — Phantom Secrets identity layer

Responsibility: read-only introspection of the `phantom` CLI. NAMES/STATUS ONLY — never values.

```ts
export function phantomInstalled(options?: { cwd?: string; timeoutMs?: number }): boolean;
// True if `phantom` binary resolves on PATH (e.g. spawnSync('phantom','--version') or 'which phantom').

export function getPhantomStatus(options?: { cwd?: string; timeoutMs?: number; includeAgentReport?: boolean }): PhantomStatus;
// SYNC. spawn phantom (spawnSync) read-only: version (`phantom --version`),
// initialized + secret NAMES (`phantom status` / `phantom list`; verify flags via `phantom --help`).
// NEVER capture or return secret values. On any failure: degrade gracefully with error set.
```

Imports: `node:child_process` (spawnSync), `./types.js`.

### src/core/doctor.ts — one-glance health check

Responsibility: aggregate config, phantom, and provider health into a single DoctorReport.

```ts
export async function runDoctor(cfg: AshlrConfig): Promise<DoctorReport>;
// Run checks (config present/valid, editor resolvable, phantom status, each provider endpoint,
// activeProvider resolvable, index freshness). Build DoctorCheck[] with pass/warn/fail + fix hints.
// generatedAt = new Date().toISOString(); summary = roll-up counts. Never throws.
```

Imports: `node:fs`, `./types.js`, `./config.js`, `./phantom.js`, `./providers.js`.

### src/cli/index.ts — M2 commands (extend existing dispatch)

Add to the argv dispatch (do not remove existing commands):

| command  | flags    | behavior |
| -------- | -------- | -------- |
| `doctor` |          | `runDoctor(loadConfig())` -> print checks + summary; exit non-zero if any `fail`. |
| `init`   | `--yes`  | idempotent onboarding: ensure config, detect+offer phantom + local models, set editor, `saveConfig`. **NON-TTY safe** — when stdin is not a TTY (or `--yes`), accept defaults and never prompt/hang. |

Both are implemented in `src/cli/doctor-init.ts` and loaded lazily from the dispatch switch.

---

## Native seat resolution — fresh authority vs historical display

`src/core/resources/native-profile.ts`, `account-identity-witness.ts`, `reading-cache.ts`.

- `resolveNativeSeatLaunch(options) -> NativeSeatLaunchResult` — **unchanged signature.**
  Every call reads the APFS volume identity afresh. Launch, admission, `captureEpoch`,
  `remember`, `witness`, `readResourceAccountLocalEpoch` and
  `recheckResourceAccountIdentitySnapshot` use only this path.
- `resolveNativeSeatDisplayMetadata({ accountsRoot, provider, seatId? }) -> NativeSeatDisplayMetadata | null` — **new.**
  Same manifest/launcher/directory/inode/template checks, but the volume identity may be
  a private per-device observation up to 60 s old (failures cached too, 32 entries).
  `NativeSeatDisplayMetadata` is `{ seatId, provider, command, nativeStatePath }`: no
  `ok`, `launch` or `executable`, so it is not a `NativeSeatLaunchResult`/`NativeSeatLaunch`.
- `readResourceAccountDisplayEpoch(accountsRoot, account) -> ResourceAccountDisplayEpoch | null` — **new.**
  `{ scope: 'historical-display-only', profileDigest, displayEpochDigest, accountDigest? }`;
  deliberately not assignable to `ResourceAccountLocalEpoch`.
- `createResourceReadingCache` gains optional `readDisplayEpoch`; `ResourceReadingCache.lastKnown`
  uses the display epoch and no longer calls `witness()`. `witness()` stays fresh, and cached
  volume data never mints a witness, capacity or financial evidence. Historical labels are unchanged.
- Consequence: after a volume change, `witness()`, `captureEpoch` and launch reject at once,
  while `lastKnown` display may stay historical for up to 60 s.

---

## Pools JSON gift-credit row

The gift-credit row of `pools.v1` (`phm pools --json`, `GET /api/app/pools`, built in
[`pools-view.ts`](src/core/fleet/pools-view.ts)) carries three fields. They appear only on rows
with `creditUnit: "usd"`.

- `creditAsOf` is the ISO 8601 timestamp of the last balance reading.
- `creditClosed` is `true` when the lane is closed and `false` otherwise.
- `daysLeft` is the whole number of days until the gift expires, `0` once it has expired.

An unknown `creditAsOf` or `daysLeft` is `null`. `creditClosed` is never `null`: it is
`false` unless the lane is known to be closed.

---

## Build / run

- `npm run build` → tsc → `dist/`
- `bin/ashlr` (chmod +x) → `import('../dist/cli/index.js')`
- Install: `npm install -g @ashlr/phantom` (provides `phm` and `ashlr`), or from a
  checkout run `./install.sh`, which builds and links `phm` and `ashlr` into `~/.local/bin`
- Config/index home: `~/.ashlr/` (created on first run)

## Fleet status API v1

`phm fleet status-api --json` emits one `fleet.status-api.v1` object and exits 0;
invalid arguments exit 2 and an unexpected read failure exits 1. It reads the
local `~/.ashlr-runs` dispatcher state only, without starting work. `sources`
reports `healthy`, `missing`, or `degraded` for status, claimed, queue and
metrics. Missing or degraded queue counts and incomplete hourly publication
counts are null (including when the 50-record publication cap is reached). `sessions` lists up to 200 validated claimed job identifiers,
lane, tier and claim time; this is a claim observation, not proof of a live
process. `lanes` lists up to 200 observed lanes, running and target counts,
held state, 24-hour merge count and available slots. Availability is null unless
status is healthy, unpaused and observed within 60 seconds; it is not a slot
reservation. Truncation flags describe each list. `observedAt` is the producer's
last tick; `generatedAt` is the read time. Recent outcomes are the producer's
24-hour lane merge counts and the number of publication records in the last hour
(null at the underlying 50-record cap). No free text, environment,
credentials, paths, or job contents are returned. Partial source health must be
checked before interpreting observations as complete. Each lane also carries
`effectiveTarget`, the fleet controller's load-shed ceiling from the
dispatcher's `effective_target` (null when the producer does not publish it).
Available slots count against the launch target — the configured target
tightened by `effectiveTarget` — so a shed lane never reports phantom room.

## Persistent fleet worker sessions (RQ-CMP-ORG-RUNTIME-1)

`src/core/fleet/session-pool.ts` exports `sessionPoolPolicy(policy?:
SessionPoolPolicy): Required<SessionPoolPolicy>` and
`runSessionPool(ports: SessionPoolPorts, policy?: SessionPoolPolicy,
signal?: AbortSignal): Promise<SessionPoolResult>`.

- Policy fields: `tasks` (default 100, range 1–100), `rotateAfterTasks`
  (25, 1–100), `rotateAfterMs` and `taskTimeoutMs` (1,800,000 each,
  range 1–1,800,000), `renewEveryMs` (3,000, range 1–3,000). A context rotates
  between tasks; its maximum age is rotation age plus one task timeout.
- Ports: unique non-secret `id`, `now(): number`, `held(): boolean`,
  `heartbeat(): void`, `pull(): Pulled | null`, `renew(JobClaim): JobClaim | null`,
  `complete(JobClaim, resultRef: string): boolean`, `leave(): void`,
  `open(): SessionExecutor`, `emit(SessionPoolEvent): void`. Queue ports are
  synchronous authority transactions, matching the existing node pool. Lease
  periods must exceed the renewal interval plus transport latency.
- `SessionExecutor` provides `run(Pulled, AbortSignal): Promise<string>` and
  synchronous `close(): void`, which must fence/terminate outstanding work.
  One context handles sequential tasks; only one task is claimed at a time.
- Result: `{ completed: number, contexts: number, reason:
  'limit' | 'empty' | 'aborted' | 'held' | 'failed' }`. After valid setup the pool
  owns cleanup, including failure paths. Invalid policy/identity throws.
- Node, leader and task fences remain authoritative. Renew before execution,
  periodically during execution and before completion. Death, cancellation,
  timeout or lost authority stops the batch. Unfinished tasks become routable
  at claim expiry (30 seconds by default), including after SIGKILL or failed
  leave. Completed tasks never requeue. External effects require sink-side
  fencing; this does not promise exactly-once effects.
- `SessionPoolEvent`: schema `fleet.session-pool.v1`, ISO `ts`, `sessionId`,
  `context` number and `event` (`session_start`, `session_rotate`, `launch`,
  `finish`, `session_stop`). Task rows include unique attempt `job` and logical
  `jobId`; finish `outcome` is `completed` or `lease-expiry`. No prompts, output,
  credentials or fencing tokens are logged. Metrics failure stops admission.

The host adapter exports `openSessionRunner(runner: string): SessionExecutor`
and `runHostSessionPool(runner: string, policy: SessionPoolPolicy,
signal?: AbortSignal): Promise<SessionPoolResult>`. The latter validates the
operator-owned executable, requires existing node-pool configuration and local
provider login, honors host pause/KILL/capacity, joins with one slot, and appends
to `~/.ashlr-runs/metrics/jobs.jsonl`. It refuses jobs requiring secret access.

`phm fleet session run --runner /absolute/owned/runner --tasks 100
--rotate-after 25 --json` invokes a persistent `runner session` process per
context. Stdin carries one JSON line `{protocol: "phm-session-worker/v1", job,
claim}` per task. Stdout must return exactly one line `{protocol:
"phm-session-worker/v1", jobId, token, resultRef}` (at most 4 KiB), matching
that task's fence. Only an ID-shaped result reference is retained. Stderr is
ignored. The runner must sandbox provider work, fence each effect at its sink,
retain context between tasks, and terminate on stdin EOF. A new process resets
context. Arbitrary queued commands are never executed. This protocol requires
a compatible host runner; existing one-shot `runner run` programs need an
adapter. Exit codes: 0 drained/batch limit, 1 held/interrupted/failed, 2 usage.
Existing `fleet session <job> --json [--follow]` behavior is preserved.

## Fleet merge-batch action compiler v1

`src/core/fleet/merge-batch-runner.ts` exports these pure signatures and types:

```ts
const MERGE_BATCH_RUN_SCHEMA: 'fleet.merge-batch-run.v1';
type MergeBatchRiskTier = 'low' | 'standard' | 'protected' | 'unknown';
type MergeBatchActionKind = 'enqueue-merge' | 'rebase' | 'close-review' | 'wait';
function classifyMergeBatchRisk(pr: MergeBatchPr, testsImportingTier1?: ReadonlySet<string>): MergeBatchRiskTier;
function runMergeBatch(input: MergeBatchRunInput): MergeBatchRun;
```

`MergeBatchRunInput` requires `plan: MergeBatchPlan` (`fleet.merge-batch.v1`)
and `prs: readonly MergeBatchPr[]` from the same snapshot. Optional inputs are
`snapshotComplete: boolean`, `hold: ReadonlySet<string>` (short/full repo or
`*#number`), `existing: readonly RebasePlanExistingJob[]`, and
`testsImportingTier1: ReadonlySet<string>`. At most 5,000 PRs and existing jobs
are accepted; mismatched membership or readiness evidence throws. No clock or
I/O is used. `generatedAt` comes from the input plan. Snapshot parsing now adds
`MergeBatchPr.filesComplete?: boolean`; false preserves absent, capped or invalid
wire file evidence that normalization would otherwise erase.
`MergeBatchPr.supersededBy?: number` retains explicit merged-replacement evidence
from hygiene reports for close-review, including reports without file data.

`MergeBatchRun` contains `schema`, `v: 1`, `repo`, `generatedAt`, counts keyed by
`MergeBatchActionKind`, and `actions` in planned order. Every `MergeBatchAction`
contains `number`, `batch`, `headSha`, `kind`, `reason`, `ready`, `afterMerged`,
`riskTier`, `ci: 'targeted' | 'full'`, and `job: MergeBatchRebaseJob | null`.
Only merge/rebase actions may be ready. Complete file evidence and an exact
40-hex head are required; merges additionally require non-draft MERGEABLE/CLEAN.
Dirty, conflicting and behind heads rebase. Known holds and active jobs wait.
Explicit recut/rebase replacements flag close-review; overlap or title equality
alone never justifies closure. Existing one-attempt rebase refusals remain.

`MergeBatchRebaseJob` contains `id` (the existing `RQ-REBASE-<short>-<pr>-<head7>`
convention), full `repo`, `number`, `headRef`, `headSha`, `pool: 'any'`,
`tier: 'work'`, `status: 'READY' | 'WAITING'`, `afterMerged: number[]`, and
`securityPinRequired: boolean`. This is structured dispatch input, not an
already-written queue row. Dependencies name PRs that must **merge**, not jobs
that merely finish rebasing. Refresh the snapshot and replan after each merge
or rebase; never dispatch WAITING jobs against the old base. Disjoint file sets
can act concurrently; each shared file carries its last predecessor, bounding
the dependency list to fewer than 300 entries per action.

Risk classification checks protected paths (including Tier-1 tests) and pinned
machinery before docs/test-only detection. `low` recommends targeted CI;
standard/protected/unknown recommend full CI. This path-only hook grants no
check bypass: required checks, secret scans, diff-level test-tamper checks,
Security pins and the scheduled full suite remain governed by existing policy.
Consumers must revalidate repository/head/base, holds and current coverage
before execution. Close-review always requires content/evidence review.

`src/cli/fleet-merge-batch-run.ts` exports
`cmdFleetMergeBatchRun(args: string[], deps?: FleetMergeBatchRunDeps): Promise<number>`.
Its dependencies extend `FleetMergeBatchDeps` with optional `existing` and `hold`
injections. `phm fleet merge-batch-run --input open-prs.json --repo ashlrai/phantom --json`
reads the same bounded snapshots as `fleet merge-batch`; JSON is the default.
Use a gh open-PR snapshot with `headRefOid`, `mergeable`, `mergeStateStatus`,
`isDraft`, and `files` for executable recommendations. Reports without those
fields produce waits. Piped stdin and `<root>/fleet/open-prs.json` also work.
The CLI reads `<root>/queue/{router-queue.md,ready.tsv,hold-list.txt}` and reports
queue/hold source health; missing evidence is disclosed, never execution authority.
It shares the existing read-only queue parser through
`readRebaseCoverage(queueDir: string, readText: (path: string) => Promise<string>): Promise<CoverageRead>`
in `src/cli/fleet-rebase-plan.ts`; `CoverageRead` has `state: 'ok' | 'missing' | 'degraded'`
and `jobs: RebasePlanExistingJob[]`. Exit 0 emits actions, 1 emits an empty error
report for unusable/incomplete input, and 2 indicates invalid arguments.

The CLI also emits `train: GreenMergeTrain | null`. The pure
`planGreenMergeTrain(prs: readonly MergeBatchPr[], run: MergeBatchRun, rows: readonly unknown[]): GreenMergeTrain`
in `src/core/fleet/green-merge-train.ts` consumes the same validated snapshot and
action report, with healthy hold/coverage reads required by its caller. A train
has `authority: 'proposal-only'`, `validation: 'required-checks-on-combined-commit'`,
`baseRef: string | null`, `members: {number, headSha}[]` and `deferred: {number, reason}[]`.
It selects at most 16 ready enqueue actions in PR-number order, with one base,
disjoint files, explicit OPEN/non-draft identities, matching full head OIDs,
complete files confirmed by changedFiles, and nonempty, uncapped observed checks
with no failures/pending entries and at least one success (completed skipped/neutral
lanes are allowed). Missing/unhealthy queue or hold evidence produces null in the CLI.
This proposes combined validation only: consumers must recheck head/base identities,
required-check names/App identities, review, holds and Security policy through the
existing protected merge queue. It grants no CI reuse or permission to merge.
Nothing invokes gh, merges, closes, dispatches jobs or changes CI configuration.

## Feedback-to-fix pipeline — RQ-GROK-FEEDBACKLOOP-1

`src/core/fleet/feedback-triage.ts` exports pure `triageFeedback(signal, existing)`:
`FeedbackSignal {source, text, refs}` becomes an ignored reason or a classified
`TriageResult {kind, priority, suggestedLane, suggestedTier, dedupeKey, promptSeed}`.
`feedback-ingest.ts` exports bounded dependency-injected `ingestFeedback`.
`feedback-cycle.ts` exports `runFeedback` and pure `feedbackDigest`.
`src/cli/fleet-feedback.ts` exports `cmdFleetFeedback`; scan previews by default,
apply uses existing drop admission, and digest reports twelve-hour observations.
No merge, publish, send or scheduler authority is added. The full limits,
dedupe, protected-scope and failure contract is in the
[feedback pipeline contract](docs/contracts/CONTRACT-RQ-GROK-FEEDBACKLOOP-1.md).

## Fleet chief-of-staff v1

`src/core/fleet/chief-of-staff.ts` exports `FleetSnapshot`, `ChiefOfStaffPlan`,
`CHIEF_OF_STAFF_SCHEMA = 'fleet.chief-of-staff.v1'`,
`CHIEF_OF_STAFF_LIMITS: { lanes: 64; jobs: 200; outcomes: 1000; brief: 12000 }`,
`parseFleetSnapshot(value: unknown): FleetSnapshot` and
`planChiefOfStaff(snapshot: FleetSnapshot): ChiefOfStaffPlan`.
`src/cli/fleet-chief-of-staff.ts` exports `FleetChiefOfStaffDeps` (optional
`read(path): Promise<string>`, `runsDir`, `now(): Date`, `out(text)` and `err(text)`)
and `cmdFleetChiefOfStaff(args: string[], deps?: FleetChiefOfStaffDeps): Promise<number>`.
The [v1 schema contract](docs/contracts/CONTRACT-FLEET-CHIEF-OF-STAFF-V1.md)
defines bounds, deterministic rules, read-only capture and literal advisory
authority. Core has no I/O or ambient clock; the CLI never applies a plan.
## Fleet proof artifacts

`fleet.proof.v1` carries bounded claims, evidence provenance, command exits,
diff statistics, risk classification and a reviewer checklist. The bridge
publisher captures actual staged Git and runner artifacts before publication;
`phm fleet proof verify <resultRef>` checks the local digest-bound bundle without
executing commands. Agent assertions alone never establish proof. See
[the fleet proof contract](docs/contracts/CONTRACT-FLEET-PROOF-V1.md) for schema,
trust boundary, bounds, redaction and Security-pinned deployment requirements.
## Bridge publisher diff scope (`contrib/mac/publish.sh`)

The publisher stages only the job's change set, never ambient worktree state.
Change set = paths whose worktree content differs from the job's fork point
(`git merge-base BASE HEAD`) plus untracked, non-ignored files that are not
scratch-shaped (`*.backup *.bak *.orig *.rej *.patch *.diff *.swp *~ .DS_Store`).
An optional manifest `~/.ashlr-runs/<job>.files` (one repo-relative path per
line, written ops-side from the work claim) is authoritative: only listed paths
are staged; a malformed manifest aborts (`scope-manifest-invalid`). The index is
reset to BASE before staging, so a stale fork point cannot re-revert main.
Excluded paths are reported as `NOTE SCOPE_EXCLUDED`. The integrated-merge
profile is unchanged. Secret-shape, G1 and protected-path gates are unchanged.
Live install needs a Security re-pin.
## Fleet outcome measurement and advisory policy v1

`buildOutcomeMetrics` in `src/core/fleet/outcome-metrics.ts` folds injected job
events into attempt-cohort lane/model-tier rates, measured USD estimates,
repo merge velocity, seven-day revert rates and merge-time percentiles.
Missing evidence stays null; sample counts and event references accompany
measurements. `suggestOutcomePolicy` returns bounded, evidence-backed
`PolicySuggestion` advice with `suggestOnly: true`; it never applies changes.
`generateWeeklySelfReport` produces Markdown for chief-of-staff attachment.

`phm fleet metrics report --hours 24 --json`, `suggest --json` and `weekly`
read the jobs ledger only. Weekly defaults to 168 hours. The
[full contract](docs/contracts/CONTRACT-FLEET-OUTCOME-METRICS.md) defines
cohorts, observation coverage, unknowns, thresholds and exit codes.

## Agent peer mesh

[CONTRACT-AGENTNET-PEERBUS](docs/contracts/CONTRACT-AGENTNET-PEERBUS.md) pins
session-bound callsigns, team-only peer messages, Slack provisioning drafts,
the approval-gated broker and bounded chief-of-staff delegation.
## Persistent specialist identities (RQ-GROK-SPECIALISTS-1)

`src/core/fleet/roster.ts` owns `fleet-specialist-roster.v1`: named identities,
feature domains, lane/model preferences, relative memory paths, current-job
metadata and outcome statistics. `src/core/fleet/specialist-memory.ts` appends
markdown job outcomes and renders bounded, scrubbed context for future prompts.
`src/cli/fleet-roster.ts` exposes `phm fleet roster list|show|assign|note --json`.
The live session roster stays separate. Storage, exported functions, failure
behavior and verification are pinned in
[the specialist roster contract](docs/contracts/CONTRACT-SPECIALIST-ROSTER.md).

## Fleet orchestration cycle (`fleet.orchestration.v1`)

`phm fleet orchestrate [--snapshot <path|auto>] [--top <1..8>] [--apply] [--json]`
composes chief-of-staff, roster/memory, authenticated peer bus, weekly outcome
metrics and the owner thread. Default top is three. Preview performs reads only.
Apply requires fresh (at most 60 seconds old), available fleet evidence and the
existing host peer session; it never dispatches, merges, edits the queue or applies
policy. Run the command again to observe subsequent dispatch outcomes and plan
the next cycle. This command does not install a daemon or change lane execution.

PLAN retains chief-of-staff ordering and attaches weekly metrics suggestions with
`suggestOnly: true`. DELEGATE chooses idle roster identities with an explicit
matching lane allowlist, in stable identity order, and includes bounded historical
memory and relevant outcome advice. Existing peer authentication, audience,
approval, rate and KILL/pause gates remain binding. EXECUTE belongs to existing
dispatch; a handoff is no claim or proof of execution. MEASURE reads the jobs
ledger afresh each cycle; unknown evidence remains unknown. REPORT records one
bounded leader verdict/brief through `postOwnerNotice` in the desktop owner thread;
it does not add a transport or send an unsolicited external reply.

`orchestrateFleet` in `src/core/fleet/orchestrate.ts` accepts fixture snapshot/events
and host options. Apply serializes using the existing roster lock and reserves
`orchestration.json` receipts before peer sends. Job/lane/queue-time receipts dedup
retries, including drafts and uncertain delivery; a crash reservation stays visible.
A later matching finish releases only this loop's current-job metadata, without
claiming merge/proof acceptance. Undated reused job IDs remain deduplicated. The
private journal is capped at 2,000 receipts and fails closed at capacity; state
repair/archival is an operator task. Exit 0 means the cycle completed without
attention items, 1 means incomplete/refused evidence or delivery, 2 means usage.
Hermetic end-to-end coverage lives in `test/fleet-orchestrate.test.ts`.

## Per-lane measured history

`resource-live/store.ts` exports `resourceHistoryPath`, `readResourceHistoryFile`,
`parseResourceHistory`, `appendResourceHistory`; `history.ts` exports
`summarizeHistory`, `projectLaneHistory`, `readLaneHistory`. Types:
`ResourceHistoryPoint`, `ResourceHistoryFile`, `LaneHistory`, `RESOURCE_HISTORY_SCHEMA`.
The private `<runs>/state/resource-live-history.json` (`resource-live.history.v1`)
stores seven days, at most 2016 points per allowance, spaced at least five minutes.
`ResourceLiveFeed.history` and `loadSensorReport().history` carry lane-keyed history;
`WorldProjectInput.laneHistory` projects optional `WorldModel.sensors.lanes[].history`
with hourly real points, measured burn, exhaustion and reset. CLI: `cmdUsageHistory`.

## Devin Review

`DevinClient.triggerPrReview(orgId, prUrl): Promise<DevinPrReview>` posts a manual
review (create retry policy); `getPrReview(orgId, prUrl, commitSha?)` reads the
latest review. `parseDevinPrReview(unknown)` fails closed to null.
`DevinPrReview` retains the required provider fields: status, repo_path,
pr_number, commit_sha and created_at. `DevinApiError.errorCode: string | null`
is a scrubbed provider ProblemDetail code, limited to 64 safe characters.

`src/core/devin/pr-review.ts` exports `parseDevinPrRef`, `DevinPrRef`,
`planDevinPrReview`, `devinPrReviewKey`, `triggerDevinPrReviewOnce`,
`DevinPrReviewDeps`, `DevinPrReviewResult`, `DevinPrReviewReason`,
`readDevinReviewFindings`, `DevinReviewFindings`, `DevinReviewSignal` and
`fleetDevinReview`. Requests reserve a repo/PR/head key under a local store lock
before contact; ambiguous outcomes cannot be retried. Unknown weekly allowance
refuses contact; quota errors stop further requests that local day.
Config `devin.review.maxPerDay` defaults to 5; 0 disables review requests.
`MergeAutopilotPr.devinReview?: DevinReviewSignal | null` and injectable
`MergeAutopilotDeps.devinReview` expose advisory evidence only: classification
and merge gates are unchanged. Dry runs neither contact Devin nor journal.

## Devin weekly capacity

`DevinWeeklyInput` and `DevinWeeklyDeps` accept optional `accountId` and `model`.
`DevinWeeklyCapacity` emits optional `account_id` and `model`: the connected Devin
org ID and configured fleet model, omitted when unknown. Explicit dependencies
override these defaults. `devinWeeklyObservation` forwards these and `window_start`.
`ResourceLiveObservation` accepts optional `account_id`, `model`, `window_start`;
the engine retains them in verified readings and normalizes window instants like
`reset_at`. Preview observations carry the first matched free model ID, never an
account ID (the CLI catalog exposes none).

`src/core/devin/weekly-capacity.ts`: `measureDevinWeekly`, `readDevinWeeklyCapacity`,
`publishDevinWeeklyCapacity`, `readPublishedDevinWeekly`, `devinWeeklyObservation`,
`devinPreviewObservation`, `devinWeeklyWindow`, `devinWeeklyAllowance`, `devinWeeklyLine`
and `DevinWeeklyCapacity { used, limit, remaining, limit_source, window_start, reset_at,
burn_rate_per_hour, sessions, source, observed_at, state, reason }`. Unknown fields are
`null`. `DevinSession.createdAtMs` (optional) and `devinInstantMs` come from
`core/devin/client.ts`. Config: `devin.weeklyAcuAllowance`, `devin.weeklyResetAt`.
`ResourceLiveSourceOptions` gains `readDevinWeekly`, `readDevinPublished` and
`readDevinModels`. See [Devin weekly allowance](docs/RESOURCE-EVIDENCE.md#devin-weekly-allowance).

## Node host capacity

`assessNodeCapacity(ramBytes, memory, freeDiskBytes, light?, options?)` and
`readNodeCapacity(light?, options?)` accept optional `CapacityOptions` with a
trusted pack name/resource hint (`memory-bound` or `cpu-bound`) and injected CPU
reader. CPU-bound packs require finite nonnegative load averages and a positive
integer `availableParallelism`; one-minute load plus one must fit parallelism.
`omlx-chat` opts in; API/probe packs and unspecified hints retain memory-only
admission. Existing RAM, pressure, disk and light-profile limits are unchanged.

`readNodeCapacity` applies `shareNodeCapacity(capacity, options?)`, with optional
injected `HostSlots` registry/owned `HostSlotLease`. The physical host's existing
advertised RAM budget is shared by every worker identity on the OS account,
independent of `ASHLR_HOME` and `HOME`. `HostSlots.acquire(budget)` atomically
leases the lowest available slot; `lease.release()` requires ownership. Workers
acquire before pull, check the actual pack before spawn and retain leases through
runner close. Full occupancy never revokes an existing lease.

New `NodeCapacity.held` values are `host-slots-exhausted`,
`host-slots-unmeasured`, `cpu-pressure`, and `cpu-unmeasured`, always with zero
slots. Pool `status` includes local `capacity`; worker results report holds.
The private registry uses native hardware digest/boot identity; missing identity,
unsafe paths or corrupt state hold admission. Leases have no time-based expiry:
a crashed worker's reservation remains until verified offline cleanup or reboot.
See [node admission](docs/NODES.md#small-mac-enrollment-and-admission).

## Node provider binaries and runner errors

`src/core/drive/nodes/provider-binary.ts` exports `NODE_PROVIDERS`,
`isNodeProvider`, `providerBinaryCandidates(provider, deps?)` and
`resolveProviderBinary(provider, deps?) => string | null`, the single absolute
allowlist resolver (no `PATH` lookup). `worker.ts` adds
`probeProviderBinaries(run?, deps?) => ProviderBinaries`,
`classifyRunnerReply(code, fenced, stdout)`, `PACK_FAILURE_LIMIT` (2), and an
optional third `binaryDeps` argument to `probeNodeLanes`. `NodeRunnerRequest` gains
optional `providerBinaries`; `NodeRunnerDeps` gains `resolveBinary`.
`codex-pack.ts` exports `CODEX_OUTPUT_LIMIT` (48 KiB), `nodeWorkDir`, `codexFileArgv`
and `runCodexFilePack`, which writes a mode-0600 `node-results/<jobId>.json` artifact on success only.
See [node runner](docs/NODES.md#reference-runner-security-review-before-installation).

## Node route lane outcomes (`phantom.node-route-outcomes.v1`)

`src/core/drive/nodes/route-outcomes.ts` exports `ROUTE_OUTCOMES_SCHEMA`,
`foldRouteLaneOutcomes(outcomes)` and `readRouteLaneOutcomes({runsDir?})`.
The fold turns `router.outcome.v1` records into the `{provider: {attempts,
merged}}` tallies `planAutoscaleRoutes` consumes: one record is one attempt
only when its merge verdict is known (`merged` true or false); `merged: null`
is excluded from both sides, never counted as a failure. A merge recorded as
reverted (`reverted: true`) counts as an attempt but not as a held merge,
matching `proposeRouterWeights`. `readRouteLaneOutcomes`
wraps the bounded `readRouterOutcomes` ledger read: 'read' carries the tallies,
'missing' is an absent journal with empty tallies, and 'unreadable'/'not-file'
report unusable evidence. `phm node route --outcomes-ledger [--runs-dir <dir>]`
merges these tallies under any explicit `--outcomes` file (file wins per
provider) and reports `outcomes_ledger` state in its JSON plan. See
[measured capacity and routing](docs/NODE-ROUTER.md#measured-capacity-and-node-provider-model-routing).

## Ready queue to node bridge (`phantom.node-bridge.v1`)

`src/core/drive/nodes/ready-bridge.ts` exports `runNodeBridge`, `planNodeBridge`,
`parseReadyRow`, `remoteLaneCap`, `remotePackFor`, `bridgeLeaseOwner`,
`nodeBridgeReadiness`, `flockDispatcher`, `localBridgeRouter`, `poolBridgeRouter`,
the constants `NODE_BRIDGE_SCHEMA`, `NODE_BRIDGE_LEASE_PREFIX`,
`NODE_BRIDGE_READ_ONLY_KINDS`, `NODE_BRIDGE_WORKTREE_PACK_ENABLED`,
`NODE_BRIDGE_PENDING_TTL_MS` and `NODE_BRIDGE_MAX_PER_PASS`, and the types
`NodeBridgeReport`, `BridgeRowDecision`, `BridgeNodeView`, `BridgeLeaseView`,
`BridgeRouter`, `ReadyRow`, `NodeBridgeHost`, `NodeBridgeOptions`,
`DispatcherLock` and `AcquireDispatcherLock`.
`BridgeRouter.scope` is a stable, non-secret identity of the canonical router
store location; `localBridgeRouter(nodes, storeDirectory)` and
`poolBridgeRouter(call, storeDirectory)` derive it from the real store path.
Bridge manifests bind `owner` and
optional `routerScope`; reconciliation holds owner mismatches as
`hold-owner-mismatch` and missing or changed scopes as `hold-router-mismatch`,
without withdrawing or requeueing those leases.
`src/core/drive/nodes/ready-bridge-run.ts` exports `readNodeBridgeConfig`,
`runConfiguredNodeBridge`, `NodeBridgeConfig` and `NodeBridgeRunOptions`.
`DriveNodes.withdraw(jobId, owner)` returns a `WithdrawOutcome`
(`withdrawn | held | completed | absent`). It fences a pending or lapsed job
with a fresh token (`WITHDRAWN_RESULT`) and persists `producerWithdrawn: true`;
that marker, not the result or node ID, distinguishes a producer withdrawal
from an accepted completion. `JobView.producerWithdrawn` exposes the marker,
and `JobView.claimedBy` names the node whose live session can still act on a running claim.
`src/core/drive/nodes/runner-packs.ts` exports
`probeRunnerPacks(runner, run?)`, which returns `pack:<name>` caps from
`<runner> packs`. `runner.ts` exports `NODE_RUNNER_PACKS` and
`NODE_RUNNER_PROTOCOL`, and `phm node run-once packs` prints them.
`ready-bridge-child.ts` is the spawned entry for the daemon phase, and
`resolution-observer-scheduler.ts` now exports `childRuntimeArgs`.
`TICK_PHASE_NODE_BRIDGE_MS` bounds the `node-bridge` phase. See
[docs/NODE-ROUTER.md](docs/NODE-ROUTER.md#ready-queue-bridge).

## Fleet compute observation (`fleet.compute.v1`)

`GET /api/verse/fleet/control/compute` serves the read-only projection in
`src/core/fleet/compute-view.ts`: local OS readings, registered node heartbeat
observations, fenced job placement and dispatcher lane hard caps. All missing
measurements are null and source failures are explicit. No parameters or writes
are accepted. Node beats may carry the closed numeric `HostStats` schema defined
in `src/core/drive/nodes/state.ts`; legacy beats remain valid. This telemetry
never changes routing authority. See [machine telemetry](docs/MACHINE-TELEMETRY.md#unified-fleet-compute-map).

## Fleet session map (`fleet.sessions.v1`)

`GET /api/verse/fleet/control/sessions` composes the existing
`GET /api/fleet/sessions` dispatch inventory with `fleet.compute.v1` through
`src/core/fleet/sessions-view.ts`. It accepts no query parameters or mutations.
The existing sessions endpoint and its schema remain compatible.

The map projection preserves inventory source states, counts, sessions and
recent rows unchanged, and adds `computeAt`, `mapSessions` and `mapRecent`. Map
rows contain `nodeId`, `placement`, `mapState`,
`branch`, `worktree`, `activity` and `detailSources`, alongside job/lane/model,
status, elapsed and outcome fields. Counts describe the local
dispatch inventory; claim-only remote rows are additional observations, with
unknown lane/model/status and null elapsed time. Placement uses a unique fenced
node claim or a confirmed local worker process. Conflicting claims or a remote
claim conflicting with a local process yield null placement. Queue membership
alone never establishes a node. Map states group launching/running/publishing
as running, exited as idle (awaiting reap), parked as held, queued as queued,
and stale/unknown/finished as unknown. No absence establishes idle capacity.

Only local inventory rows receive bounded, scrubbed job details (at most 100,
eight concurrent readers); omitted evidence stays null and limits set
`truncated`. Worktree `recorded` means branch metadata exists in the base
receipt, not that the directory still exists or is clean. Paths are withheld;
no worktree traversal, provider calls or raw prompt reads occur. Activity is
the last retained scrubbed log excerpt, capped at 160 characters, with unknown
activity time; it is not a semantic completion claim. Remote claims never read
local artifacts with matching job names. Missing sources and telemetry remain
explicit; the map renders unknown placement and empty inventories without
seeded sessions. All reads use the existing bounded regular-file readers.
## Live sessions (`fleet.live-sessions.v1`)

`src/core/fleet/live-sessions.ts` exports `buildLiveSessions(map, now,
filter)`, `renderLiveSessionsText`, `flatTree` and `spoke` (all pure;
`sessionsByLane` is removed); `src/core/fleet/live-sessions-read.ts` exports
`readLiveSessions(options)` with injectable `readMap` and `readSubagents`.
`phm sessions [--lane] [--repo] [--json] [--live]` and
`GET /api/verse/fleet/control/live-sessions` (optional `lane`, `repo`,
`live=1`, each at most once; read session required) serve it. The list gains
`live` and `tree`, a `fleet.session-tree.v1` document (`version` 1) built by
the pure `buildSessionTree(records, now)` in `src/core/fleet/session-tree.ts`
from `sessionRecords(rows, map, subagents, now, options)`: leader, then
workers, then subagents, running first and then most recent, with sessions
whose parent is missing under `unknown parent`. The filter gains `live` and
`subagents` (null means unreadable). `src/core/subagent/spawn.ts` exports
`readSubagentRecords(options, limit)`. It projects the session map above;
the only source it adds is the leader's own files, for the leader row.
The filter takes an optional `leader` (`LeaderSessionFacts` from
`session-tree.ts`: `lastPassAt`, `lastReplyAt`, `lastReply`, each null when
unknown; null or absent when unread), and `sessionRecords` takes the same as
`options.leader`. The pure `leaderRecord(facts, now)` builds the row: `idle`
while the newest plan-log pass is at most `LEADER_PASS_FRESH_MINUTES` (120)
old (`leaderPassFresh`), otherwise `unknown`; `lastMessage` is the newest
reply to the owner on one line, at most `LEADER_REPLY_EXCERPT_CHARS` (240);
lane, model and start stay unknown. With facts and no lane or repo filter the
leader is listed even when no worker is. `leaderGaps(facts, now)` in
`live-sessions.ts` words what the row could not show; with no fact it is the
single line older readers print. `readLiveSessions` gains an injectable
`readLeader`, defaulting to `readLeaderSessionFacts(options)` in
`live-sessions-read.ts` (plan-log heading time and `leader.replies.v1`,
bounded tails, never throws); the HTTP route reads it at most once per 15 s. The session map gains `localNodeId`, and
`fleet.sessions.v1` rows gain optional `lastOutputAt` (the `<job>.log` lstat
mtime; absent from older servers). Rows cover launching, running, publishing
and claim-only (`unknown`) sessions. Unknown text fields read `unknown`, unknown
times are null, and `unknown` names the reason for each. `quiet` is true after
10 minutes without output and null when that time is unknown.
`throttledLiveMap` is now generic over its value type.

## Session threads (`fleet.session-threads.v1`)

`src/core/fleet/session-threads.ts` exports the pure
`buildSessionThreads(list, parts, now)`, `renderSessionThreadsText(read)`,
`threadSessions(list)`, the limits `THREADS_MAX` (40 sessions),
`THREADS_MESSAGES_SHOWN` (3) and `THREADS_TEXT_CHARS` (400), `THREAD_STATES`
and the types `SessionThreadsV1`, `SessionThreadsEntry`,
`SessionThreadsMessage` and `SessionThreadsParts`. `parts` is
`{sessionsRead, bus, activity, replies?, owner?, orders?}`, where `activity`
maps a job id to its activity read (null when that read failed, no key when it
was not asked for), `owner` is the Leader inbox, handed to the leader's and
every worker's thread and to no helper's, and `orders` is the order trace
(`OrderTraceV1`), handed to the leader's thread and to every worker's that has
a job. `SessionThreadsV1.sources` is `{sessions, bus, owner, replies, orders}`. Each entry is built by
`buildSessionThread`, so its session, summary, sources, gaps and `reply`
(its last key, the `SessionThreadReply` of `session-reply.ts`) equal the
single-session thread for the same records.
`src/core/fleet/session-threads-read.ts` exports `readSessionThreads(options)`
with `lane`, `repo`, `live` and injectable `readMap`, `readSubagents`,
`readLeader`, `readActivity`, `readBus`, `readOwner`, `readReplies` and
`readOrders`; the list, the bus, the Leader inbox, the leader's replies and
the order trace are read once and each shown job's activity once.
`src/cli/sessions.ts` exports `cmdSessionThreads(args, read)` for
`phm sessions threads [--lane <lane>] [--repo <repo>] [--live] [--json]` (exit
0 read, 1 list unreadable, 2 usage).
`src/core/verse/fleet-session-threads-api.ts` exports
`createFleetSessionThreadsApi(read)`, `defaultSessionThreadsRead()`,
`handleFleetSessionThreadsApi` and `SESSION_THREADS_PATH` for
`GET /api/verse/fleet/control/session-threads` (read session required; 200,
400, 401, 405, 503). It adds no source and writes nothing. Fields are listed
in `docs/FLEET-API.md`.

## Session thread (`fleet.session-thread.v1`)

`src/core/fleet/session-thread.ts` exports the pure
`buildSessionThread(list, id, parts, now)`, `renderSessionThreadText(thread)`,
`sessionBusMessages(session, messages)`,
`sessionOwnerMessages(session, entries)`, `SESSION_ID_RE`, the
`THREAD_*_SHOWN` limits, `THREAD_OWNER_WINDOW` and the types
`SessionThreadV1`, `SessionThreadSession`, `SessionThreadMessage`,
`SessionThreadParts`, `SessionThreadOwnerRead`, `SessionThreadState` and
`SessionThreadSource`. `parts` is
`{sessionsRead, activity?, bus, owner?, replies?}`: null means that read
failed, absent means it was not asked for. `owner` is the Leader inbox as
`readInboxEntries` returns it. Additive: messages gain the kind `owner` (key
`owner:<id>`) and `sources` gains `owner`; no field was removed.
Routing (additive): `parts` gains optional `orders` (`OrderTraceV1 | null`,
from `readOrderTrace`), messages gain the kinds `order` and `routing` (keys
`order:<id>`, `routing:<id>`), `sources` gains `orders`, the module exports
`THREAD_ORDERS_SHOWN` and `THREAD_ROUTED_SHOWN`, and `readSessionThread`
takes an injectable `readOrders`.
Reply (additive): the document gains a last top-level key
`reply: {to: 'leader' | 'job' | 'none', mention: string | null, hint: string}`,
built by the pure `sessionReply(session | null)` that the new import-free
`src/core/fleet/session-reply.ts` exports with `SessionThreadReply`,
`SessionReplySubject` and `AIMABLE_JOB_RE`; `session-thread.ts` re-exports
`sessionReply` and `SessionThreadReply`, and `renderSessionThreadText` gains
a "To write to it" line.
`src/core/fleet/session-thread-read.ts` exports `readSessionThread(id,
options)` with injectable `readMap`, `readSubagents`, `readActivity`,
`readBus`, `readOwner` and `readReplies`; each read is guarded on its own and the result is
sanitized like the session list. `src/cli/sessions.ts` exports
`cmdSessionThread(args, read)` for `phm sessions thread <id> [--json]` (exit 0
read, 1 list unreadable, 2 usage or unknown id).
`src/core/verse/fleet-session-thread-api.ts` exports
`createFleetSessionThreadApi(read)`, `defaultSessionThreadRead()`,
`handleFleetSessionThreadApi` and `SESSION_THREAD_PATH` for
`GET /api/verse/fleet/control/session-thread?id=<id>` (read session required;
200, 400, 401, 404, 405, 503). It adds no source and writes nothing. Fields
are listed in `docs/FLEET-API.md`.

**Org tree states (RQ-ORGVIEWN18BQ8).** `fleet.org.v1` gains `version: 1` and,
on the leader, every lane and every job, `state` (`OrgState`: `running`,
`idle`, `held`, `done`, `unknown`) and `doing` (plain words). The leader gains
`provider` and `model`; lanes gain `model` and `heldReason`. Additive: no field
was removed. `fleet.sessions.v1` rows gain optional `published` (the publish
record has a `RESULT` line written since this dispatch), `FleetMapNode` gains
optional `published`, and a published job is `done` and leaves its lane's
`running` count. `readFleetOrgSources(minutes, readers?)` and
`readFleetOrgMap(minutes, readers?)` take an optional `Partial<FleetOrgReaders>`
(`live`, `sessions`, `runs`, `ledger`, `models`, `messages`, `now`); defaults
are exported as `fleetOrgReaders`. `OrgTreeInputs` gains optional `models`.

**Org chart (RQ-ORGCHARTN18PQ8).** `fleet.org.v1` gains optional `planners`
(`OrgTreePlanner[]`: `id` `OrgPlannerId`, `label`, `role`, `state`, `doing`,
`lastActivityAt`), built only from the dispatch events and message edges the
tree already reads. `OrgTreeJob` gains `tier`, `ageSeconds` and `goal`;
`FleetMapNode` gains optional `tier` and `goal`. `ORG_PLANNER_QUIET_MS` is
exported. Lane `doing` for idle and held lanes now names the reason. Additive;
`version` stays 1.

**Org health and message times (RQ-ORGMAPN20QQ8).** `fleet.org.v1` lanes gain
`health` (`LaneHealth | null`, the lane badge from `getFleetLaneSnapshot`; null
when that read had no verdict) and each `messages[]` row gains optional `lastAt`
(ISO, newest message on the line). `OrgTreeInputs.laneHealth` and
`FleetOrgReaders.laneHealth` are new. Additive; `version` stays 1.

## Runtime-dynamic fleet config (RQ-DYNCONFIG-1)

`src/core/fleet/dynconfig.ts` exports `createConfigReader`, `sharedConfigReader`,
`liveOverride`, `setLiveOverride`, `clearLiveOverride`, `readConfigAudit`,
`classifyKey`, `validateOverride`, `RESTART_REQUIRED`, `MUTABLE_KEY_PATTERNS`,
`PINNED_DEFAULTS`, `DynConfigError` and the types `ResolvedConfig`, `LiveEntry`,
`LiveConfigFile`, `AuditEntry`, `ConfigAuditReport`. `src/cli/fleet-config.ts`
exports `cmdFleetConfig(args: string[]): Promise<number>`.

Precedence (low to high): pinned defaults < slots.json < budget-overrides.json <
`queue/live-config.json` < one-shot CLI. Writes are lock + temp + rename; the audit
line in `queue/live-config-audit.jsonl` (`fleet.config.audit.v1`) records
who/when/why. Restart-required keys (security pins, paid-model blocks, credential
paths, GATES files) are refused by the writer and ignored by the resolver. See
[docs/FLEET-CONFIG.md](docs/FLEET-CONFIG.md).

## Agent Bus v2 foundation

`src/core/agents/bus-v2-schema.ts` owns the `agent-bus.v2` body, participant,
claim and work-feed schemas described in [Agent Bus v2](docs/AGENT-BUS.md#v2),
plus `busBodyThread(body)`, the read-side predicate that returns the `thread`
label a `note`/`context` body carries (null for every other kind and shape).
Routing labels, repo slugs and claim tokens reject trailing newlines; claim keys
reject ASCII controls including DEL. Claims grant no execution authority.

`projectBusWorkFeed(receipts: readonly unknown[], participants?: readonly Participant[], providerFor?: WorkFeedProviderFor, ownerKeyFor?: WorkFeedOwnerKeyFor)`
in `src/core/agents/bus-work-feed.ts` returns `WorkFeedResult`: either
`{status:'ok', feed:{v:2,jobs:WorkJob[]}}` or `{status:'refused',reason}`.
It validates at most 1024 retained receipts in strictly increasing cursor order;
legacy and unrelated bodies stay opaque. Posts start queued with `owner=from`,
`to` set to the announcement envelope's routing label, and the announcement's
own `title` plus optional `dispatch` spec carried onto the job so the feed
names the work it lists;
provider comes from the post, explicit participant metadata, or the
injected `providerFor` resolver — schema-checked, never guessed (missing is refused).
Statuses update only retained jobs from the same owner: exact sender-label
equality, or — when the injected `ownerKeyFor` resolver maps both labels to one
nonempty key — any labels of that identity; labels the resolver cannot place
still require exact label equality. Orphan statuses are ignored. Duplicate job
posts and malformed work bodies refuse the projection. Latest cursor wins; `updatedAt` is its receipt time. Jobs retain post order.
This is a pure retained-snapshot projection, not a historical ledger or
authentication check. It performs no I/O, transport, claim mutation or execution. Existing v1
journals/readers remain unchanged; feed output is explicitly versioned `v:2`.
`readBusWorkFeed` (`src/core/agents/bus-work-feed-read.ts`) is the bounded
read-only reader over the local inbox; `GET /api/verse/agent-bus/work-feed`
(`src/core/verse/agent-bus-api.ts`, read session required; `claims=true` is
the only accepted parameter and adds the `claims` hold join, every other
parameter or value is a 400) serves its `BusWorkFeedReadResult` as `{v:1, ...}` — `ok` and `refused` answer
200 with the projection's own status, `unavailable`/`retryable`/`invalid`
answer 503.

`readBusWorkFeed({root?, now?, claims?, participants?, providerFor?, ownerKeyFor?})` in `src/core/agents/bus-work-feed-read.ts`
pages the bounded bus inbox without writes and returns ok/refused/unavailable/
retryable/invalid with receipt count and `asOf`. `runtimeProvider(identity)` is the exported newest-runtime provider
lookup both the feed hints and `announceWork` share. Omitted post providers fall back
to the sender identity's newest registered runtime in the agent registry beside
the bus store (`resolveAgent` over handle, `agent:<handle>`, stable id and
aliases), and `ownerKeyFor` falls back to that identity's stable id so statuses
posted under any of one identity's labels update its jobs; an absent or
unreadable registry hints nothing, and explicit `providerFor`/`ownerKeyFor`
replace the registry fallbacks. With `claims:true` the ok result
adds `claims:{source,holds,truncated}`: holds list each live coordination lease
blocking a job's declared claim keys (`jobId`, `claimKey`, `owner`,
`leaseUntil`, `origin`, `sourceId` — tokens never leave the store); `source` is
`missing`, `available` or `unavailable`, and holds are unknown, not empty, when
the table is unavailable. Holds cap at 1024 with `truncated` set.
`BUS_FEED_OPEN_STATUSES` is the exported set of feed statuses that still mean
open for a worker (`queued`, `rescheduled`); the comms inbox pending-work view
and `claimBusWorkJob` share it so "claimable" means one thing.
`coordinationRowBlocks(row, key)` in `src/core/agents/claim-store.ts` is the
exported read-only overlap predicate; acquisition and observation now share one
structural overlap rule. `projectBusWorkFeedView(result, filters?)` applies the
client-side feed filters (`{status?, jobId?, toMatch?, ownerMatch?}`),
newest-first order and per-job hold regrouping; `toMatch` is the predicate
`busWorkFeedToMatcher(to, {root?})` builds over a job's `to` label and
`ownerMatch` the predicate `busWorkFeedOwnerMatcher(owner, {root?})` builds
over its `owner` (announcer) label — each matching literally and under every
label of one agent identity (an unresolvable ref or unreadable registry keeps
exact-label matching). `formatBusWorkFeed(result)` renders the shared human
lines — each job as `<id> <status> "<title>" owner=… keys=<claim keys>` with
title and keys scrubbed, single-lined and display-clipped (JSON keeps the full
values) — both feed CLIs use them, and both accept `--to <label>`, `--owner
<agent>` and `--job <id>` beside `--status`. `phm fleet work-feed [--claims]
[--to <label>] [--owner <agent>] [--job <id>]` and
`phm agents bus work feed [--status] [--claims] [--to <label>] [--owner
<agent>] [--job <id>]` print the same
projection — hold lines plus a `claims=` footer — and non-ok reads print
`jobs=unknown` rather than a fabricated count.

`src/core/agents/bus-claims.ts` executes the v2 claim protocol bodies. Exports:
`BusClaimOptions` (`root?`, `now?`), `BusClaimResult` (the `{v:2, ...}` result
union: `acquired`/`renewed` carry claim details including the fencing `token`,
`released`/`completed` carry `claimKey`, `conflict` carries `holder` without a
token, and `mismatched-token`/`expired`/`lost`/`invalid`/`unavailable`/`full`
are bare statuses), `executeBusClaimBody(body, opId, options?)` (returns
undefined for non-claim bodies so opaque mail still appends),
`BUS_CLAIM_HTTP_STATUS`, `busClaimExitCode(result)` and `newBusClaimOpId()`.
`listBusClaims(BusClaimsListOptions)` (`root?`, `now?`, `key?`, `owner?`,
`jobs?`) is the
read-side companion: it returns the live coordination claims as
`CoordinationView` rows (fencing tokens never leave the store) with `source`
of `missing` (verified empty), `available` or `unavailable` (holds unknown,
not free), plus `asOf`. A malformed `key` or `owner` answers `invalid`; a set
`key` narrows the list through the same `coordinationRowBlocks` overlap rule
an acquire applies, previewing the claims that would block it. A set `owner`
narrows to one holder: a handle, `agent:<handle>`, stable id or alias that
resolves through the identity registry matches every label of that identity;
an unresolvable ref or unreadable registry falls back to the exact owner
label, and the result's `owner` field (`ref`, resolved `identity` or null,
`registry` state) reports which mode applied so a label match is never
mistaken for identity proof. With `jobs:true` each claim gains an optional
`jobs` list of the announced work-feed jobs its keys block (`{id, owner,
status, title}` per job, the reverse of the feed's `--claims` hold join) and the
result's `feed` field reports the feed read state; a non-`ok` feed leaves
`jobs` absent so blocked work stays unknown, never an empty list.
`phm agents bus claim list [--key] [--owner] [--jobs]`
prints it.
`claimBusWorkJob(BusWorkJobClaimOptions)` (`job`, `owner`, `leaseMs`, the
`BusClaimOptions` `root?`/`now?`, and optional `key?`/`id?`) is the job-level
companion to `claim acquire`: it reads the live work feed, requires the job
shown and open under `BUS_FEED_OPEN_STATUSES`, resolves one of the job's
declared claim keys (`queue:<jobId>` preferred, else the first declared; an
explicit `key` must be declared) and acquires through the same
`executeBusClaimBody` path, so overlap with every other claim origin still
decides in one place. `BusWorkJobClaimResult` echoes the announced job
(`{id, owner, repo, title, status}`) on every outcome that found it:
`acquired` carries the claim with the fencing token for its acquirer only,
`conflict` the holder without one, and
`invalid`/`refused`/`unavailable`/`retryable`/`full` carry a slug `reason`
(`invalid-job`/`invalid-owner`/`invalid-lease`/`invalid-key`, `unknown-job`,
`job-not-open`, `no-claim-keys`, `undeclared-key`, `work-feed-*`,
`claim-*`). A feed that cannot be read refuses rather than claiming against a
guessed job. `phm agents bus work claim --job <id> --lease-ms <ms> [--key]
[--owner] [--id]` prints it, exit 0 acquired, 2 invalid, 1 otherwise.
`work.claim` acquire/renew run through `acquireCoordination`/`renewCoordination`
and `work.release` through `settleCoordination` on the one coordination table
with `origin:'resource'`; lease source ids are `agentbus:<opId>:<sha256-16 of
claimKey>` so an operation id retried on the same key replaces its own lease
while reuse on another key cannot relocate it. Claims coordinate only and grant
no execution authority; the token returns only to its acquirer.

`src/core/agents/bus-work-mine.ts` is the read-side per-agent digest behind
`phm agents bus work mine [<agent>]`. `readBusWorkMine(agent, options?)`
(`BusWorkMineOptions`: `root?`, `runsRoot?`, `now?: () => number` frozen once
across all reads) returns `BusWorkMineResult`: `{status:'ok', agent,
asOf, claims, jobs, next, handoffs, wakes, inbox}` or `{status:'invalid',
reason}` for a
ref outside the printable-label rule. `agent` echoes `ref`, resolved
`handle`/`identity` (null when unregistered) and the `registry` state.
`claims` reuses
`listBusClaims({owner})` — identity-aware owner matching with exact-label
fallback — as `{status:'ok', source, claims, owner}` or `{status:'unavailable'}`;
each claim row is a `BusClaimsListClaim` that gains `jobs` (the announced jobs
its keys block, `{id, owner, status, title}`) only when the feed read is `ok`,
absent otherwise. `jobs` reports the open feed jobs
(`BUS_FEED_OPEN_STATUSES`, at least one claim key, newest 50 of `open`) as
`BusWorkMineJob` (`WorkJob` plus `addressed`, `announced`, `freeKeys`,
`heldKeys`, `claimable`): `addressed` marks a `to` label resolving to the
agent's identity and `announced` an `owner` label resolving to it (the agent
posted the job and owns its status reports) — both through the same
identity-label contract the feed `--to`/`--owner` filters use;
`holds` is `complete`/`truncated`/`unknown` from the feed's
claims join, and `claimable` is `true` only on a provably free key, `false`
only when every declared key is provably held, `null` when coverage is
`truncated` or `unknown` — `busWorkMineJobAnnotation(job, held, coverage,
addressed, announced?)` is the exported pure rule. A non-ok feed collapses the section to
its own status (`refused` keeps `reason`/`receipts`). `next` lists the
claimable work envelopes addressed to the agent — every live receipt whose
`isClaimableWork` body (`kind:'work'` or a protocol-v1 `task`) and whose `to`
label resolves through the same identity matching `bus next` and the feed
`--to` filter use, or names a `group:<channel>:<topic>` address of a
registry channel the resolved identity belongs to (the same membership rule
the inbox and wake reads apply, minus the agent's own channel posts; an
unreadable or missing registry and an unresolvable ref contribute no
channels, so matching never widens) — in `claimNextBusWork` claim order
(priority band, then
cursor), capped at the first 10 shown with `matched` the true total and
`truncated` definitive. Each `BusWorkMineNextItem` carries `cursor`,
envelope `id`, the raw `to` routing label, `priority`, `ts`, `expiresAt`
(read time plus the receipt's
remaining TTL — the reader decrements `ttl`, so this is the live deadline),
`kind` (`'work'`|`'task'`), raw `from`, resolved `fromAgent`, a
`summary` through `busBodySummary`/`busBodyFallbackSummary` scrubbed,
single-lined and clipped like the inbox section, and tri-state `held`:
`true` when a taken message-id claim row (live lease or completed, the same
rule the unified inbox applies) or a live coordination row blocking
`queue:<envelope id>` provably covers it, `false` when provably free,
`null` when hold coverage is unknown — the `holder` label rides along only
when `held` is `true`. Section-level `holds` is `complete` or `unknown`:
a store that cannot be read (claims journal or coordination table) keeps
`held` null and `holds` unknown rather than fabricating `false`, matching
the unified inbox's degraded rule; an unreadable bus store reports the
section's `unavailable`/`retryable`/`invalid` status with `reason`.
`handoffs` is collected in the same bounded store walk as `next` and lists
the live `worker-handoff` envelopes addressed to the agent under the same
label-or-member-channel rule — only bodies the
shared `isWorkerHandoffBody` contract (`src/core/fleet/handoff-body.ts`)
accepts, the same check `fleet handoff-receive`/`handoff-reply` run (exactly
the `kind`/`taskId`/`prompt` keys, a fleet job id, a non-empty prompt), in the
same claim order, capped at the first 20 shown with `matched` the true total
and `truncated` definitive. Each `BusWorkMineHandoff` carries `cursor`,
envelope `id` — the handle `handoff-receive`/`handoff-reply --id` take — the
raw `to` routing label to pass verbatim as `--to` (a channel-addressed
handoff matches only its literal `group:<channel>:<topic>` label, never the
agent's own labels), the
body's `taskId`, `priority`, `ts`, `expiresAt`, raw `from`, resolved
`fromAgent`, the same scrubbed single-line `summary`, and the same tri-state
`held`/`holder`: a taken claim or coordination hold is reported as evidence,
never a gate, because receiving a handoff checks no claims. Section-level
`holds` follows the same `complete`/`unknown` rule as `next`, and a failed
walk reports the same `unavailable`/`retryable`/`invalid` status on both
sections.
`wakes` reuses
`readAgentWakes` capped at the newest 20 with `truncated`, or
`unknown-agent`/`unavailable` with `reason`. `inbox` reuses `readAgentInbox`
for the next page of mail addressed to the agent — same matching, order and
owner-share receipt checks as `agents bus inbox` — as `{status:'ok', agent,
messages, nextCursor, truncated}`: each `BusWorkMineInboxMessage` carries
`cursor`, envelope `id`, `ts`, `priority`, `kind`, `channel`, raw `from`,
resolved `fromAgent` (null when unregistered) and a `summary` through
`busBodySummary`/`busBodyFallbackSummary`, scrubbed, single-lined and clipped
to 200 characters for both JSON and human output. The read asks
for one row past the 20-message cap so `truncated` is definitive — a full
window proves mail remains beyond `nextCursor`, a short one proves the scan
reached the store's end — and on overflow the newest scanned row is the one
dropped, so `nextCursor` resumes strictly before it. A non-ok inbox read
reports `unknown-agent`/`unavailable`/`retryable`/`invalid` with `reason`.
`formatBusWorkMine(result)`
renders the shared human lines — titles and key lists scrubbed, single-lined
and display-clipped; JSON keeps full values. Exit 0 on a completed read, 2 on
an invalid agent.

### Unified agent bus (RQ-BUS-UNIFY-1)

`src/core/agents/bus-identity.ts`: `stableAgentId(handle): string` (`agt_` + 20 hex),
`agentAddress(handle)`, `resolveAgent(registry, ref)`, `agentLabels(identity)`,
`agentIdentityKeys(options?)`, `agentAddressMatcher(identityOf, label)`,
`RESERVED_PREFIXES` (the `agent:`/`group:`/`dm:`/`handoff:` label prefixes no
alias and no label post may claim),
`readAgentRegistry(options?)`, `registerAgentIdentity(input, options?)`,
`createAgentChannel(input, options?)`, `joinAgentChannel(name, agent, options?)`,
`leaveAgentChannel(name, agent, options?)`. Results are status objects
(`created|updated|unchanged`, or `invalid|conflict|full|not-found|unavailable|retryable`
with a `reason`); they never throw for bad input or storage faults.

`src/core/agents/bus-unified.ts`: `sendDirectMessage`, `postChannelMessage`,
`postLabelMessage`, `sendHandoff`, `sendWakeRequest`, `announceWork`,
`updateWorkStatus` (all `Promise<UnifiedSendResult>`: `posted|duplicate` with `id`,
`cursor`, `to`, `wake`, or a refusal with `reason`; the posted shape may also
carry `claimHoldersWoken`), `readAgentInbox(ref, {after, limit, thread?, from?}, options?)`
(`thread` keeps only `note`/`context` bodies carrying that v2 thread label and
`from` filters by sender through identity-label matching, an unresolvable ref
keeping exact-label matching),
`readAgentWakes(ref, sinceAt, options?)`, `listBusChannels(agent, options?)`
(the registry channels name-sorted with `createdBy`, `createdAt` and member
handles in join order — all of them, or only those one resolved identity
belongs to; `source` is `missing` for a verified-empty registry or
`available`, `agent` the resolved handle or null, and an unknown ref or
unreadable registry answers `unknown-agent`/`unavailable`, never an empty
list), `readAgentChannel(name, {topic, from, thread, after, limit}, options?)`
(one oldest-first page of a registry channel's live posts addressed to
`group:<name>:*` — or one topic — with `group.presence` heartbeats
excluded; `from` filters by sender through identity-label matching and
`thread` keeps only `note`/`context` bodies carrying that v2 thread label,
`nextCursor` covers every scanned row, a missing registry answers
`unknown-channel`, and an unreadable registry or store answers
`unavailable`/`retryable`, never an empty page passed off as history),
`readBusEnvelopeById(id, options?)` (one retained envelope by its wire id —
the key wake hints, claim operations and `work mine` items cite — via the
same bounded page walk; live rows only so an expired or never-posted id
answers `not-found`, an unreadable store `unavailable`/`retryable`, the read
needs no identity, and `fromAgent` sender decoration is best-effort so an
unreadable registry never hides the envelope),
`shouldWake(priority, requested, handoff?)`
and `busBodySummary(body)` — a pure, secret-scrubbed read of a bus body for
inbox surfaces (`note`/`context`/`worker-handoff` return their message text,
possibly multi-line; every other recognized kind — the v2 work/wake bodies
plus the channel, leader, peer, group, cos and incident notices that share
the store — composes one `<kind> <subject>: <payload>` line, and protocol-v1
transport bodies summarize their `protocol` kind/topic/ref), null when the
body has no typed content; `busBodyFallbackSummary(body)` is the shared
bounded fallback for bodies it does not know — string bodies as their
scrubbed single-line text, anything else as a secret-scrubbed raw JSON
render clipped to 512 characters. Claim tokens and `work.result`
queueId/receiptId never appear in a summary.
Every send is one `appendBusInbox` post; wakes go through `createBusWakeHook`.
`announceWork(WorkAnnouncementInput)` posts a schema-checked v2 `work.post` to
`DEFAULT_WORK_ADDRESS` (`leaders`, overridable per send) at P2 with a 7-day
TTL; its provider is the explicit input or the sender identity's newest
runtime provider (`runtimeProvider`), and it refuses `conflict` when the live
feed already shows the job id. `updateWorkStatus(WorkStatusInput)` posts a
v2 `work.status` only for a job the feed shows, and only from the identity
that announced it (resolved through any of its labels). Both read
`readBusWorkFeed` before appending and propagate a refused, retryable,
invalid or unavailable feed as a refusal — they never post unchecked and never
dispatch, claim or execute. A terminal `work.status` (`done`, `failed`,
`terminated`) additionally queues one routing-only wake hint per distinct live
claim owner whose coordination keys overlap the job's claim keys — capped at
32, deduped by a deterministic per-envelope-and-holder id, skipped for the
poster's own identity, and suppressed by `--no-wake`; the posted result's
`claimHoldersWoken` counts hints present afterwards, `null` when the claim
table is unreadable. `sendWakeRequest(WakeRequestInput)` posts a
schema-checked v2 `wake` body to `agent:<handle>` for a registered recipient
and always records the routing-only wake hint for that same address — the
body's purpose is the hint, so `wake: false` is refused — with `reason` capped
at 512 characters and an optional `jobId` that only threads the message, never
a feed lookup. `postLabelMessage(LabelPostInput)` posts a schema-checked v2
`note` (or `context` with `kind`) to any printable routing label outside
`RESERVED_PREFIXES` — the sink/topic mail the identity and channel verbs
cannot carry — under the same registered-sender, scrub, wake and dedupe rules;
a `to` matching one of a registered identity's labels lands in its inbox as
legacy mail.

`src/core/agents/bus-cli-adapters.ts`: `listBusCliAdapters()`, `getBusCliAdapter(cli)`,
`detectBusCli(env)`, `attachBusCliSession(input, env, options?)`, `busSelfFromEnv(env, options?)`,
`frameBusInbox(cli, messages)` renders each body through `busBodySummary`,
falling back to `busBodyFallbackSummary` for unrecognized bodies. Identities
are routing names and grant no authority.

`src/core/agents/bus-status.ts`: `readUnifiedBusStatus(options?)` composes one
read-only probe over the five dependencies the unified verbs touch — the
message store (`inspectBusInbox` pass-through), the identity registry (counts,
null when unreadable), the wake queue (`state` plus the observed hint count,
null unless `ok`), the shared coordination table (`coordinationSummary`) and
the work-feed projection (job count, or the refusal `reason`). Each section
reports its own real state, a failed probe degrades only its own section, and
the read never throws, writes or takes a lock; unknown stays null, never zero.
See [Unified bus](docs/AGENT-BUS.md#unified-bus-identities-dms-channels-handoffs-and-wake).

`fleet.specialist-identity.v1` adds a read-only identity/outcome projection over
specialist roster metadata, orchestration assignments and real jobs.jsonl rows.
Optional role, capabilities, machine/lane affinity and peer mappings persist in
roster v1. Legacy counters never supply measured outcomes; missing evidence is
explicit and peer mappings confer no authority. See the
[specialist roster contract](docs/contracts/CONTRACT-SPECIALIST-ROSTER.md#evidence-derived-identity-rq-agent-identity-1).

`fleet.plugins-panel.v1` and `fleet.skills-panel.v1` (`src/core/fleet/installed-panels.ts`):
`readPluginsPanel(opts?)`, `readSkillsPanel(opts?)`, `formatInstalledPanel(panel, noun)`.
Read-only lists of the plugins and skills fleet agents have: Phantom plugins and
Claude Code installed plugins; Claude Code, Codex and learned skills. Each row has
`name`, `source`, `agents` (plain words), `enabled` (boolean or `'unknown'`) and
`lastUsed` (`'unknown'`; no usage record exists yet). Each source reports
`read`, `none` or `unknown`; an unreadable source adds no rows. Served by
`phm plugins list --all --json`, `phm skills list --all --json` and
`GET /api/verse/fleet/runs/plugins|skills` for the desktop Plugins and Skills panes.

`phantom.inventory.v1` (`src/core/fleet/inventory.ts`, wire types in
`inventory-schema.ts`): `buildInventory(sources)`, `readInventory({ home?,
runsDir?, now?, readers? })`, `filterInventory(inventory, kind)` and
`formatInventory(inventory)`. Everything the install can use in one list, joined
from the channels overview, the connector profile, the plugins and skills
panels, tool parity and the shared tool registry. Each item is `{ kind:
channel|connector|plugin|skill|tool, id, name, state: ready|needs setup|off|
error|unknown, detail, lastChecked, usedByLanes: string[]|all|unknown, next:
{ text, command }|null }`. A source that cannot be read (null) yields one
`unknown` row, never a guess. `counts` and `kinds[].counts` total the five
states. `parity` compares every lane (`ORG_LANES`, then any other lane a source
names) against each tool and connector that is not off: `{ compared, widestGap,
lanes: [{ lane, has, lacks, unknown, gap }] }`. No credential name or value is
included; connectors report only how many credential names they list. Read-only.
Served by `phm inventory [--kind K] [--json]` and
`GET /api/verse/fleet/runs/inventory[?kind=K]` (400 for an unknown kind) for the
desktop Inventory pane. `installed-panels.ts` now exports
`INVALID_MANIFEST_AGENTS` and `LEARNED_SKILLS_SOURCE`, and
`connectors/mesh.ts` exports `executableAvailability(command, path)`.

`tools.matrix.v1` (`src/core/fleet/tool-parity.ts`): `buildToolMatrix(report, lane?)`,
`formatToolMatrix(matrix, lane?)` and `loadToolParity({ runsDir?, home?, readers? })`.
Which lane has which tool. Rows are capabilities (GitHub read/write, web search,
browser, computer use, shell, package install) then named MCP servers, CLIs,
skills and plugins; each cell is `{ value: yes|no|unknown, source }`. `scores`
give each lane's share of yes rows; `topGaps` holds at most three gaps with one
plain `fix`. `readers` (connectors, lane-tools, slots) are injectable for tests.
Read-only. Served by `phm tools [--json] [--lane L]` and
`GET /api/verse/fleet/runs/tools[?lane=L]` (404 for an unknown lane) for the
desktop Tools pane.

`tools.parity.v2` (same module): `buildLaneParity(report, lane?, roster?)` and
`formatLaneParity(matrix)`. One row per lane (`ORG_LANES`, then any other lane a
source names), one cell per tool family in `TOOL_FAMILIES` (`mcp`, `cli`,
`skills`, `plugins`, `web-search`, `browser`, `computer-use`, `gh`). Each cell
is `{ state: present|missing|unknown, source, has?, lacks?, fix? }`; `fix` is
set on missing cells only. `version` is 2, `counts` totals the three states, and
an unnamed lane yields null. Served by `phm tools parity [--json] [--lane L]`
(text by default; it replaces the `tools.parity.v1` JSON and `--text` table that
command used to print) and `GET /api/verse/fleet/runs/tools/parity[?lane=L]`
(404 for an unknown lane) for the Tool parity card on the Tools pane.
`formatToolParity` is removed.

`src/core/fleet/fleet-held.ts` exports the pure `fleetNotRunning({ lanes,
launches, metricsTail, metricsClipped?, now, limit? })`, returning
`NotRunningRow[]`: `{ job_or_lane, kind, reason, since, unblock }`. `kind` is
`held_launch` (a `<job>.launch` record whose first line is not `launched ...`),
`idle_lane` (target above 0, nothing running, nothing queued),
`launched_no_finish` (launch older than 60 minutes with no finish) or
`finished_no_publish` (a non-empty finish 10 minutes to 24 hours old with no
publish row and no `<job>.publish`). `since` is ISO or null when not known.
`unblock` is one plain sentence; an unrecognized reason passes its raw first
line through as `reason` with `unblock: "unknown"`. A null `metricsTail` leaves
the finish and publish kinds unlisted. `readFleetRunsDirState` reads the newest
500 launch records from the last 7 days and returns the list as `notRunning`
(empty for a missing directory). `phm fleet held [--json]` prints it
(`fleet.held.v1`: `{ schema, generatedAt, count, items }`; exit 0 when read, 1
when the read fails, 2 for bad arguments), `GET /api/verse/fleet/runs` carries
it as the additive `notRunning` field, and the desktop Fleet hub shows it first
as "Not actually running" when it is not empty.

`src/web-ui/routes/verse/panes/pane-presence.ts` exposes `hasRegisteredPane(id)`,
`subscribeRegisteredPaneIds(listener)` (returns an unsubscribe function), and
`publishRegisteredPaneIds(ids)`. The registry publishes membership synchronously;
first-paint consumers observe it without importing pane definitions or shortcuts.

### Agent app adapters

`src/core/agents/apps/`: `AgentAppAdapter` (`describe`, `launchTask`, `listSessions`,
`readSession`, `sendMessage`, `readUsage` → `AgentAppResult<T>`), `createRegistry`,
`describeAgentApps` (`ashlr.agent-apps.v1`), `createAgentAppRegistry(deps?)`,
`createCliAgentApps(deps?)`, `createDesktopAgentApps(deps?)`. See [Agent app adapters](docs/AGENT-APPS.md).

## Cross-provider subagents (subagent.v1)

`src/core/subagent/spawn.ts` exports `MAX_SUBAGENT_DEPTH = 3`, strict Zod
`subagentRecordSchema`, `SubagentRecord`, `SubagentSpawnInput`, `SubagentOptions`,
and these asynchronous APIs:

- `planSubagentSpawn(input: SubagentSpawnInput, options?: SubagentOptions)` →
  `{schema:'subagent.spawn.v1',ok,dry_run,applied:false,record,parent:{id,depth,kind:'root'|'subagent'},routing:{decision,eligible_lanes,excluded_lanes:[{lane,reason}]},reason_codes,next_step}`.
- `listSubagents(parentId: string, options?: SubagentOptions)` →
  `{schema:'subagent.list.v1',parent_id,count,subagents:SubagentRecord[]}`.
- `readSubagentRecord(id: string, options?: SubagentOptions)` → `SubagentRecord|null`.
- `writeSubagentRecord(record: SubagentRecord, options?: SubagentOptions)` → `void`.

Options: `home`, `runsRoot`, `nowMs`, `kill:()=> 'active'|'inactive'|'unknown'`,
`paused:()=>boolean`. Input: `parent_id`, `tier`, `task`, optional
`tools_allowed`, `write_scope`, `max_tokens`, `max_cost_class`, `task_class`,
`repo`, `apply`. Defaults and subset rules: [Subagents](docs/SUBAGENTS.md).
Refusals are values, not exceptions. Storage failures may throw.

Strict record fields: `schema:'subagent.v1'`, `id` (`sa-` + 16 random hex),
`parent_id` (bounded session/job identifier), `depth` (positive integer),
`tier` (`fast|mid|work|frontier`), `lane:string|null`, `model:string|null`,
`tools_allowed` (read/search/edit/test/shell/web array), `write_scope:string[]`,
`max_tokens` (positive integer), `max_cost_class` (`local|included|metered`),
`state` (`planned|held|refused|running|completed|failed`), `result_ref:string|null`,
`created_at` (ISO timestamp), `reason_codes:string[]`, `task_digest` (SHA-256 hex).
No task content is stored. Dry-run writes nothing. Successful apply stores
held only; no live execution, enqueue, queue file writes or paid model calls.

`src/core/subagent/result.ts` exports:
- `readSubagentResult(id: string, options?: SubagentOptions)` →
  `{schema:'subagent.result.v1',id,found,state,result_ref,lane,depth,reason_codes}`;
  missing records have null state/reference/lane/depth.
- `recordSubagentResult(id: string, input:{state:'completed'|'failed',result_ref:string}, options?: SubagentOptions)`
  → `{ok:boolean,reason:string|null}`. Only held/running may transition.
  References match `^(run|pr|proposal|job|artifact):[A-Za-z0-9._:/#-]{1,200}$`.

Subagent-pattern parent IDs (`^sa-[a-f0-9]{16}$`) require a valid stored record
or refuse `parent-not-found`. Stored parents outside planned/held/running
refuse `parent-state-invalid`. Both gates skip routing. Non-subagent parent
IDs resolve as root sessions/jobs with fixed frontier tier,
read/search/edit/test/shell tools, `**` write scope, 200000 tokens and
included cost class.

Reason codes: `parent-not-found`, `parent-state-invalid`, `depth-exceeded`, `scope-tools-not-subset`, `scope-write-not-subset`,
`write-scope-invalid`, `scope-cost-not-subset`, `scope-tokens-not-subset`,
`scope-tier-not-subset`, `tool-unknown`, `kill-engaged`, `paused`,
`no-eligible-lane-quota`, `input-invalid`, `apply-inert-no-scoped-live-path`,
plus existing router reason codes (including `admission-blocked`). Result
updates may refuse with `not-found`, `state-transition-invalid`,
`result-ref-invalid`. CLI uses sanitized public JSON and exit 0/1/2 for
success/refusal-or-missing/usage.

### PR append-union conflict resolution

`resolvePrConflicts(ConflictOptions): Promise<ConflictReport>` in
`src/core/fleet/pr-conflict-resolver.ts` inspects one pinned open PR in a
disposable git repository/worktree. The exact `APPEND_UNION_ALLOWLIST` and empty
diff3 base regions constrain resolution; GATES v3 and holds override any
configuration. Dry-run is the default. Apply runs generators and verification,
then revalidates PR identity, holds and master before export or sanctioned
publication. `ConflictReport.status` is `needs-agent`, `would-resolve`,
`ready-supersede` or `published`; available scrubbed conflict hunks and failed
command names remain evidence. No direct push fallback exists.
`runPrConflictResolution(ConflictRunOptions): Promise<unknown>` reads GitHub and
fleet hold evidence for the `pr.resolve-conflicts.v1` CLI envelope.
See [the resolver guide](docs/PR-CONFLICT-RESOLVER.md).
