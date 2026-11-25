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
`SeatState`, `SeatHandoff`, `SeatHandoffPlanEntry`, `SeatHandoffsPlan`,
`SeatStoreInspection` and `SeatOptions`. The strict on-disk roster schema is
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
  claims, claimsOwner, inFlight, recent handoffs and advisory adapter status. Only lifecycle
  transitions may persist during listing; missing node stores stay missing.
  Open work counts live coordination claims owned by `participantId` or by any
  other label of the same registered bus identity; an unreadable identity
  registry keeps exact-label matching. `claimsOwner` reports `{ref, identity,
  registry}`: the participant label, stable identity id (null when unresolved),
  and registry source (`missing`, `available` or `unavailable`).
- `seatMayClaim(id: string, opts?): Promise<boolean>` accepts only active seats
  with measured quota. The module acquires no claims.
- `seatParticipants(opts?): Promise<Participant[]>` projects poll participants;
  draining/idle map to idle. `phm agents bus id list` adds these as `participants`
  without modifying stored identities, channels or authority.
- `planSeatHandoff(id: string, opts?)` is a dry-run projection; active seats are
  refused. `planSeatHandoffs(opts?)` is the fleet-wide dry-run: one snapshot
  returns `{schema:'phantom-bot-handoffs-plan.v1', apply:false, seats}` with one
  `{seatId, participantId, state, eligible, handoffs}` entry per roster seat —
  `participantId` is the bus routing label the seat's claims and messages
  answer to — ineligible seats
  report `eligible:false` and no records rather than erroring, and pending
  handoff ids are the same deterministic ids the single-seat plan and apply
  journal. Both plans enforce the same eligibility rule (draining seats always;
  idle seats only while holding work or carrying handoff history). Neither
  writes state. `applySeatHandoff(id, opts?)` uses a stale-safe lock, fsyncs one
  `phantom-bot-handoff.v1` record per work/lease identity before releasing work,
  retries held releases on replay, declines node sessions and releases bus
  claims by source — `origin:'message'` claims first settle through the bus
  work-claims journal's owner-authorized release
  (`releaseBusWorkClaimForOwner` in `src/core/fleet/bus-work-claims.ts`), which
  drops the journal row and its coordination partner under the journal writer
  lock so the two stores cannot drift; a claim that cannot name a journal row
  still takes the by-source path alone. Source releases require the current
  owner; seat handoffs also match the captured stored lease generation. Team
  and board clears use owner-only fencing because acquisition may normalize
  the requested expiry. It returns
  `phantom-bot-handoff-plan.v1` with `apply`, state
  and handoffs; apply handoffs include `notifications: {bus, owner}` statuses.
  Durable notice receipts suppress repeated attempts; crashes before receipt
  persistence retry with stable deduplication keys. Notification exceptions are
  value-free statuses, not post-release exceptions. `applySeatHandoffs(opts?)`
  is the fleet-wide apply: one `planSeatHandoffs` snapshot picks eligible seats,
  then each runs the same `applySeatHandoff` serialized by the shared lock,
  returning `{schema:'phantom-bot-handoffs-apply.v1', apply:true, seats}` with
  per-seat `{seatId, participantId, eligible, outcome, state, handoffs, reason?}`
  — outcome `applied`/`skipped`/`contended`/`failed`, `reason` a fixed
  value-free phrase or 'unavailable' (never a raw error that could carry a
  path), `state` the apply's reported state on applied seats and the plan
  projection otherwise, `handoffs` the journaled `AppliedSeatHandoff` records
  with notification receipts on applied seats only. A throwing plan read
  propagates; a partial apply is safely re-run.
- `sendSeatMessage({from, to, text}, opts?)` delegates configured participants to
  unified bus DMs under the seat's fleet root and clock, or owner notices;
  `from`/`to` accept a seat id or participantId (`to: 'owner'` posts an
  owner-thread notice). Unknown seats/secret-shaped text are refused.
- `inspectSeatStore(home?: string): SeatStoreInspection` is the synchronous,
  never-throwing file probe behind `agents bus status`'s seats section — the
  file half of the same `snapshot()` `planSeatHandoffs` reads plus the
  `handoff-notices.json` receipts map `applySeatHandoff` indexes and
  rewrites. It reports
  `source` (`missing` for an absent bots directory with real zero counts,
  `unavailable` when the directory or any present file fails the `safe()`
  checks or roster/journal/receipts-map validation, `available` otherwise)
  plus retained
  `seats`/`states`/`handoffs`/`notices` counts, each null only for the file
  that cannot
  be read or validated. It reads no seat contents, claims or quota evidence
  and writes nothing.

`SeatOptions` injects home, runs, clock, fleet root, quota reader, node store,
node-release
port, owner-thread options, owner notice and bus post. `fleetRoot` overrides
the fleet root the coordination table and identity registry read (default
`<home>/.ashlr/fleet` with `home`, else the shared coordination root) so a
caller whose bus stores live under a different fleet root joins the same
table. Default coordination and
node storage use canonical roots; owner defaults use the same fixed
settings/runs construction as the comms CLI, mirror onto the seat fleet root
and retain KILL/pause checks.
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

# Landed-sweep git-only fallback (pending)

This contract describes the exports proposed in [PR #7764](https://github.com/ashlrai/phantom/pull/7764)
(`RQ-LANDEDSWEEPN22GQ8`, head `706b61180db`). The module and fallback are
not available on master until that implementation lands.

`src/core/fleet/landed-git-only.ts` exports:

- `GhFailureKind = 'missing' | 'signed-out' | 'offline' | 'error'` and
  `GhFailure { kind: GhFailureKind; reason: string }`.
- `describeGhFailure(run: { stderr: string; missing?: boolean; timedOut?: boolean }): GhFailure`
  is pure. An explicit missing flag takes precedence, followed by recognized
  authentication errors, then timeout/network errors. Reasons are respectively
  `gh not installed`, `gh not signed in`, and `network unreachable`. Other
  errors use `gh failed: <first nonblank stderr line>`, capped at 160 characters
  for that line, or `gh failed: no output`.
- `GitOnlyBranch { name: string; landed: boolean; ahead: number }` and
  `GitOnlyResult`, a union of `{ state: 'ok'; base: string; branches: GitOnlyBranch[] }`,
  `{ state: 'skipped'; reason: string }`, and `{ state: 'failed'; reason: string }`.
- `GitOnlyOptions { repoDir?: string; base?: string; git?: GitRunner }` and
  `gitOnlyLanded(options?: GitOnlyOptions): Promise<GitOnlyResult>`. Defaults
  are the process working directory, `master`, and `defaultGitRunner`. Each
  git invocation has a 60-second timeout. The function checks the clone, fetches
  `origin <base>` without tags, then inspects local and origin branch refs,
  excluding the base, `origin/<base>`, `origin`, and `origin/HEAD`. It returns
  `base: 'origin/<base>'`; a branch is landed only when its ahead count is zero.
  This tests commit reachability, not patch equivalence or PR closure. Missing
  git or a non-clone returns `skipped`; fetch, ref-list or invalid ahead-count
  results return `failed`. Fetch updates Git metadata; no branch or PR is
  closed or deleted and no worktree file is changed.

The same proposal adds `FleetDirtyLandedDeps.onGhFailure?: (failure: GhFailure) => void`
and `FleetLandedSweepDeps.repoDir?: string` / `git?: GitRunner` to the CLI seams.
The sweep falls back only for classified missing, signed-out or offline gh
failures. Its JSON adds `state: 'ok' | 'skipped' | 'failed'`,
`mode: 'gh' | 'git-only'`, optional `reason` and optional `landedBranches`.
Git-only results report branch counts and names, with zero planned/closed PRs
even under `--apply`. A skipped fallback exits 0; a failed fallback or other gh
error exits 1. Invalid CLI arguments retain exit 2. This contract grants no
execution, closure, merge or release authority.

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
Devin preview evidence. `LaneAllowanceRow.windowStart` is the start the
measured reading reports for its window: null when the reading names none, is
not usable, or names a start at or after the reset; it is never derived.
Missing measurements stay null; stale values retain
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
read-only version 1 evidence report, and `parseBaselineFailures(log, repo?,
auditExceptions?)` for capped, scrubbed failure identities -- Vitest
`file > name` and suite-load
`file > (suite)`, TypeScript `<file> > (typecheck)`, check:docs
`<file> > (docs-check)`, node:test TAP `file > suite > test` /
`file > (suite)` resolved through the Actions checkout marker,
clean-tree `<file> > (generated)` rows from the stale-files porcelain dump
and launcher-digest check, the release-metadata gate
`scripts/sync-candidate-version.mjs > (version-sync)` from the build's
`check:version` drift JSON report or `sync-candidate-version: <message>`
error, the advisory perf gate's
`<budgets file> > (perf-budget) <target id>` rows from the
`ashlr.perf-budget-report.v1` JSON document (`fail` and `error` results
only), and the Dependency Audit job's
`<lockfile> > (dependency-audit) <package>` rows from npm audit v2 JSON
reports (advisories outside the exception fixpoint only) and from the
npm-transport-fallback OSV-Scanner table report (the pinned scanner's
own `IgnoredVulns` config has already filtered excepted advisories, so
those rows need no exception fixpoint), the
pack-smoke/artifact gate's
`.github/scripts/ci-pack-smoke.mjs > (pack-smoke)` /
`scripts/hosted-build-artifact.mjs > (hosted-artifact)` rows from the
scripts' `pack smoke refused:` / `hosted artifact refused:` stderr
prefixes, and the PR-visible trust gates'
`.github/tests/secret-shape/scrub.pl > (secret-shape)` /
`.github/workflows/ci.yml > (secret-scan)` /
`.github/workflows/ci.yml > (secret-shape-gate)` /
`.github/workflows/ci.yml > (secret-scan-gate)` /
`.github/scripts/release-version-provenance.mjs > (version-provenance)`
rows from the scrub.pl `<blocked> allowed=<n>` count, the gitleaks
`leaks found: <n>` summary, the scanners' pre-verdict bootstrap
failures (the pinned-hash `: FAILED` checklist lines naming
`scrub.pl`/`gitleaks.tar.gz`, `secret-shape base is missing`, fatal
perl diagnostics naming `scrub.pl`, and `secret scan refused an
incomplete commit range`) and the provenance `::error::` /
`check failed:` lines (nonzero counts and verdicts only), the
memory benchmark gate's
`scripts/benchmark-memory.ts > (memory-benchmark)` rows from the
`memory benchmark below floor:` stderr block and its two-space-indented
violation lines, and the `ci` job's Lint step eslint stylish output as
`<file> > (lint)` rows -- absolute checkout-marker file headers,
`line:col severity message ruleId` rows, `error` severity only and gated
on the `✖ N problems` run summary -- the same step's
`<file> > (realio-lane)` rows from the
`[check-realio-lane-membership]` section headers and their bare test
paths (missing-members reasons included; the soft-signal advisory
section stays unparsed) and `<file> > (verse-sync-io)` rows from the
`verse-sync-io: N synchronous call(s)` header and its
`<file>:<line>  <call>(…)  → <hint>` route-file rows, the first-paint
budget gate's
`scripts/check-first-paint-budget.mjs > (first-paint) chat` /
`> (first-paint) phone` rows from the `OVER BUDGET: <arm>
first-paint critical JS <kb> KB (budget <kb> KB)` verdicts and its
`> (first-paint) gate` row from the script's
`check-first-paint-budget: <message>` error lines, plus
summaries. `auditExceptions` is the optional
`DependencyAuditException[] | null` list (`{id, package, graph}` with
graph `full` or `raycast-production`); `null` leaves npm audit reports
unparsed but still parses OSV fallback tables, whose advisories the
scanner already filtered through its own ignore config. TAP `ok` results carry no
location, so TAP failures never resolve a master pass or flake
classification. Generated artifacts carry no import closure: `docs/llms.txt`
depends on its generator inputs and every public docs page from the master
tree listing (unreadable or truncated listings fail closed), and
`scripts/canonical-launcher-digests.json` on `bin/ashlr`. The version-sync
gate's dependency set is the script plus the ten metadata files it rewrites
(seeded as static inputs), and the vitest harness ambient set does not apply
to it. The perf gate's dependency set is the budgets file plus its direct
inputs (`bin/ashlr`, `scripts/perf-budget.mjs`,
`scripts/perf-mcp-tools-list.mjs`, seeded as static inputs); the measured
CLI graph has no enumerable closure, so the harness ambient set alone
decides manifest and toolchain touches. Each audited lockfile's dependency
set is its manifest, shrinkwrap, .npmrc, the lockfile itself,
`.github/dependency-audit-exceptions.json` and
`scripts/npm-audit-with-osv-fallback.sh` (seeded as static inputs), and the
harness ambient set does not apply to it either; the analyzer reads the
exception file once from master and an unreadable or malformed file
leaves npm audit reports unparsed rather than risk phantom groups for
accepted advisories (OSV fallback tables still parse). The pack-smoke gate's dependency set is
`package.json` and the artifact gate's `package.json` plus
`package-lock.json` (seeded as static inputs, since the measured dist/
graph has no enumerable closure), and the harness ambient set does not
apply to either; refusal continuations stay excerpt-free, empty
messages and release-only `* refused:` prefixes stay unparsed. The
secret-shape and secret-scan groups key on the scanner definition alone
(the diff and commit-range scans have no enumerable repo input, so a
shape carried inside a PR's own diff stays unattributed), the gate
bootstrap groups take the closed input lists of the repo files their
steps execute (`.github/workflows/ci.yml` plus `scrub.pl` for
secret-shape, plus `ci-fetch-range.mjs` for secret-scan's
merge-group/push scan-base path), and the
provenance group's dependency set adds `package.json` and
`.release-please-manifest.json` as static inputs; the harness ambient
set does not apply to any of these gates. The memory benchmark gate's
dependency set is the entry script's import closure -- the benchmark,
its floors file and the `src/core/memory` implementation -- plus
`package.json`, `package-lock.json` and `tsconfig.json` seeded as
static inputs for the toolchain files tsx reads, and the harness
ambient set does not apply to it either. The lint gate's dependency set
is `eslint.config.js`, `package.json` and `package-lock.json` -- never
the failing file's import closure, since eslint's rules are per-file --
and the harness ambient set does not apply to it either. The realio-lane guard's
dependency set is the checker script plus its imported lane manifests,
measured-fast allowlist and lane-inventory helper, and the
verse-sync-io guard's is the checker script alone -- closed input
lists, never the failing file's import closure, and the harness ambient
set does not apply to either. The first-paint budget gate's dependency
sets are likewise closed input lists -- the checker script,
`vite.config.web.ts`, `package.json`, `package-lock.json`,
`src/web-ui/tsconfig.json`, `src/web-ui/index.html`,
`src/web-ui/main.tsx` and the presentation-format modules the vite
config names, plus each arm's manifest roots
(`src/web-ui/app/VerseConsoleApp.tsx` and
`src/web-ui/routes/verse/sections/ChatSection.tsx` for chat,
`src/web-ui/app/VerseMobileApp.tsx` and
`src/web-ui/routes/verse/mobile/screens/HomeScreen.tsx` for phone; the
gate identity takes the union of both arms) -- never the failing
file's import closure, since the measured bundle graph has no
enumerable closure, and the harness ambient set does not apply to it
either. Parenthesized
gate identities other than `(suite)` can never resolve a master pass or
flake classification, even when their file is a test path a green-module
line could otherwise match.
`enqueueBaselineFixes(report,
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

`router/outcomes.ts` exports `foldRouterOutcomes(text, {passkFor?, workClassFor?, revertedPrKeys?, mergeEvents?})`,
`authorityRevertedPrKeys(evidence)`, `foldSpendCosts(text)`,
`foldRouteDecisionWorkClasses(text)`, `foldRouteDecisions(text)`,
`foldMarketHandoffAdvisories(text)`,
`foldEmptyTags(text)`, `foldMergeEvents(text)`, `foldRewardSignals(text)`,
`foldLaunchCosts(text)`,
`readLedgerFile(path, limit?)`,
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
skipped. The same newest-decision collapse also supplies the market's
recorded routing verdict: `foldRouteDecisions` returns each job's
latest `route_decision` row as `{lane, preferred, override, reasons,
rejected}` and the read joins it under the same `market_state` health as
`work_class` — `market_lane` is the recorded `chosen_lane`,
`market_preferred` the recorded `preferred_lane`, `market_override`
the override's recorded reason (`override.reason`), `market_reasons`
the recorded `reason_codes` list (deduplicated,
bounded reason-code shape, capped), and `market_rejected` the recorded
`rejected_lanes` list — each entry `{lane, reasons}` where `lane` is
the rejected lane's bounded identifier and `reasons` its recorded
`reason_codes` under the same dedup/bound/cap rules (`null` when
missing or all-unrecognizable, `[]` when recorded empty). A missing
field stays `null`;
a non-array or all-unrecognizable `reason_codes` reads as unrecorded
(`null`), while a recorded empty list stays `[]`; a `rejected_lanes`
member that is absent or whose every entry is malformed reads as
unrecorded (`null`), while a recorded empty list stays `[]`. Rows
naming jobs
outside the jobs window never create outcomes. The market ledger's
`session_handoff_advisory` rows join under the same health through
`foldMarketHandoffAdvisories` — each job's newest recorded advisory
(by finite epoch `ts`) supersedes the jobs-ledger
`handoff_trigger`/`handoff_lane`/`handoff_target` triple only when
its `ts` is strictly newer than the standing jobs-ledger advisory's
parseable timestamp; a market advisory fills the triple when no jobs
advisory exists, an unorderable jobs advisory leaves the jobs verdict
standing, and advisory rows naming jobs outside the jobs window join
nothing. The market read degrades
independently too:
`RouterOutcomeRead.market_state` reports its health and
`market_truncated` marks a cut tail; anything but `read` leaves
classes and verdict fields ledger-recorded only. `repo` is the repo
the job targeted, recorded on jobs rows as `repo` — dispatchd writes
the ready line's repo cell on its queue rows (enqueue/claim/launch/
skip/defer/outcome/task_outcome alike). It joins only in the bounded
repo-label shape — a bare fleet name (`phantom`, `lexicon`) or an
`owner/repo` pair, each segment a bounded identifier — with the
newest recognized value winning like `lane`/`model`/`tier`: a row
without `repo` or with a value outside the shape leaves the standing
record, so absolute paths, whitespace and deeper paths are skipped,
never recorded raw, and the field is never guessed from the job id
or PR URL. It stays `null` when no retained row recorded a bounded
repo — unknown, not "no repo". `empty_tag` joins the same bound of
`metrics/empty-tags.jsonl`: `foldEmptyTags` collapses `job.empty-tag.v1`
rows — the `{schema, job, lane, tag}` records the daemon's
`empty-tag-sync` off-tick job and `phm jobs empty --record`
append from the fleet's final-output verdict (src/core/fleet/
empty-tags.ts, src/core/fleet/empty-tag-sync.ts) — to each job's recorded tag in the closed
`already_done`/`pool_cap`/`blocked`/`no_change_needed`/`unknown`
vocabulary, last appended row winning a repeat. Only rows with the exact
schema, a bounded job id and an in-vocabulary tag count; malformed JSON,
other schemas and unrecognized tags are skipped, never recorded raw. The
tag attaches to the job's outcome regardless of its standing finish
verdict — it is the fleet's post-hoc why-it-ended-empty triage, distinct
from the finish row's own `empty`/`empty_class` measures — and rows
naming jobs outside the jobs window never create outcomes. The tags read
degrades independently: `RouterOutcomeRead.empty_tag_state` reports its
health and `empty_tag_truncated` marks a cut tail; anything but `read`
leaves every `empty_tag` null — unknown, never a guessed cause, and a
recorded `unknown` tag stays distinct from missing evidence.
`merge_queue` joins the same bound of `metrics/merge-events.jsonl` —
the fleet merge-latency observation journal the host merge observer and
`phm fleet merge-retry` append (src/cli/fleet-merge-latency.ts's closed
event vocabulary: `opened`/`queued`/`checks_passed`/`conflict`/
`recut_requested`/`retry_requested`/`retry_failed`/`merged`/`closed`/
`auto_merge_enabled`/`auto_merge_disabled`/`eligible`/`blocked`/
`check_observed`, keyed `repo`+`pr`). `foldMergeEvents` collapses the
rows to per-PR `owner/repo#n` evidence — the same prKey shape
`pullRequestKey` and `authorityRevertedPrKeys` produce — under the same
validation the merge-latency reader applies: a `blocked` row needs a
recorded in-vocabulary `reason` (`queue`/`required_checks`/`conflict`/
`review`/`other`), a `check_observed` row a recorded `conclusion`
(`success`/`failure`/`pending`, with `required` only as a boolean when
present), and every type outside the state/terminal set
(`auto_merge_*`/`merged`/`closed`) a parseable `at`; anything else is
skipped, never guessed. The evidence records `events` (qualifying row
count), `blocked_reasons` (distinct recorded blockers, first-seen
order), `conflicts`, `check_failures` and `required_check_failures`
(failed `check_observed` rows, split on recorded `required: true`),
`checks_passed` (recorded all-required-green boundary rows) and
`check_observations` (recorded `check_observed` rows of any
conclusion — the coverage `check_failures` counts the failure subset
of), `retries`/`retry_failures` (distinct `at`+`head_sha` pairs, the
sibling reader's replay-dedupe), `recuts` and `auto_merge` (the last
recorded toggle in append order, `enabled`/`disabled`/`null`). The
fold's `mergeEvents` option joins each outcome's `merge_queue` through
the job's newest unambiguous canonical PR claim — the same claim rule
the authority revert join applies, so a contested or foreign URL never
resolves — and merge-events rows for PRs no outcome claims unambiguously
join nothing and never create outcomes. The same joined check record
resolves `ci_first_pass` fill-only when no jobs row recorded a verdict:
any recorded `check_observed` failure — required or unrelated — reads
`false` even beside a later `checks_passed` boundary or a merge (a
rerun or a new head got it green, which is not a first pass); with
zero recorded failures a `checks_passed` boundary or a recorded merge
beside observed check activity reads `true`; pending-only
observations, no check rows at all and unmerged PRs without the
boundary stay `null` — unknown, never guessed from absent evidence.
`readRouterOutcomes` reruns the same fill-only pass after the
reward-signal join so a reward-only merge verdict reaches the
fallback. The read degrades
independently: `RouterOutcomeRead.merge_events_state` reports its
health and `merge_events_truncated` marks a cut tail; anything but
`read` leaves every `merge_queue` null — unknown, never a guessed
queue history. A sixth ledger joins under the ASHLR home root — the
same root `ashlarDir` resolves for the eval passk projection
(`ASHLR_HOME` honored): `<ashlr>/metrics/reward-signals.jsonl`, the
reward-signal substrate's per-job resolved-outcome rows
(`v:1` records the daemon's reward-sync feed and supervising bridges
append; src/core/metrics/reward-signal.ts).
`foldRewardSignals` collapses the tail to each job's recorded
`{merged, ttm_s, ci_wall_s, cost_usd, repo, pool_pct_used}` evidence —
last appended row winning a repeat, only rows with `v:1`, a bounded
`jobId`, a boolean `merged` verdict and parseable `dispatchedAt`/
`recordedAt` stamps counting, consumed fields joining under their own
bounded shapes (milliseconds become seconds, `costUsd`/`pctUsedDelta`/
`repo` keep their recorded-value-or-null rule, and `pctUsedDelta`
joins only inside the [0, 100] percentage-point shape). The read fills
only fields the jobs fold left null — `merged`, `ttm_s` (only while
the standing verdict is a merge, the same gate the jobs-ledger dialect
applies), `ci_wall_s`, `cost_usd` (after the api-spend join), `repo` —
so persisted reward evidence recovers verdicts and cost figures the
bounded jobs tail dropped without ever overriding a recorded
jobs-ledger value; the reward row's `merged:false` covers its
closed-unmerged and reverted resolutions alike (the v1 schema has no
revert dimension — `reverted` still joins independently). Reward rows
naming jobs outside the jobs window never create outcomes.
`pool_pct_used` is the row's recorded subscription-pool percentage
points consumed (`cost.pctUsedDelta`) — the only per-job
subscription-quota cost figure, since subscription lanes record no
`cost_usd` and `acus` covers only the Devin lane's ACU spend; it is a
different unit than either and never summed with them, staying `null`
when the reward ledger was not read, no row named the job, or the
row's pool window reset or readings were missing (the producer leaves
the delta null — unknown stays unknown, never 0). The read degrades
independently: `RouterOutcomeRead.reward_state` reports its health
and `reward_truncated` marks a cut tail; anything but `read` leaves
every joined field at its jobs-ledger value — unknown, never a
guessed verdict or cost. A seventh ledger joins under the runs dir —
`<runsDir>/metrics/launch-cost.jsonl` (`ROUTER_LAUNCH_COST_LEDGER_RELATIVE`),
the bounded append-only `fleet.launch-cost.v1` journal the
`launch_cost.py` producer appends and `src/core/fleet/launch-cost.ts`
reads for fleet vitals: the fleet's recorded first-minute
process/CPU probe per launch attempt. `foldLaunchCosts` collapses the
tail to per-`launchId` evidence under the producer's closed contract —
exact schema, bounded lane/launchId identifiers, a null-or-parseable
`startedAt`, `windowSeconds` 60, bounded `sampledSeconds`/`samples`,
the `measured`/`partial`/`unknown` status vocabulary, metric figures
inside their recorded shapes (`unknown` rows carry none,
`measured`/`partial` rows carry all three plus a `startedAt` and at
least one sample and peak process, `measured` rows require
`sampledSeconds` >= 59 with >= 12 samples, and mean CPU never exceeds
peak) — last appended row winning a repeat, malformed rows skipped,
never recorded raw. The producer keys measured rows
`<job>-<12 lowercase hex claim hash>` — one row per attempt — and
unknown probes by the bare job id, so the read resolves each
`launchId` against the folded job window: a launchId that is itself a
folded job id keys itself (a job id may legitimately end in a 12-hex
segment), a measured/partial row's suffix strips to the job it
measured, and an unknown-status row prefers an exact job-id match
before the stripped prefix. The join fills `launch_cost_status`,
`launch_peak_processes`, `launch_mean_cpu_pct` and
`launch_peak_cpu_pct` — fields no jobs-ledger row supplies, the only
per-attempt resource-cost evidence subscription lanes record — with
the last appended row for a resolved job standing; rows resolving
outside the jobs window join nothing and never create outcomes.
`RouterOutcomeRead.launch_cost_state` reports the ledger's health and
`launch_cost_truncated` marks a cut tail; anything but `read` leaves
every `launch_cost_*` field null — unknown, never a zeroed or guessed
resource figure. An eighth ledger joins under the ASHLR home root —
`<ashlr>/fleet/cross-review.jsonl`, the bounded append-only audit
journal the cross-provider review gate writes
(`CROSS_REVIEW_SCHEMA_VERSION` 1 rows; src/core/fleet/cross-review.ts
and cross-review-run.ts). The journal carries two row kinds: `review`
records — one per cross-model review of a standing PR, keyed
`repo`+`pr` — and `decision` records recording the merge-action the
review informed. `foldCrossReviews` collapses the tail to each PR's
newest `kind:'review'` row under the producer's closed contract:
`schemaVersion` 1, `kind` `review`, a `owner/repo`-shaped `repo`, a
positive integral `pr`, the `approve`/`reject`/`failed`/`skipped`
outcome vocabulary, and a bounded `at` stamp (unparseable stamps keep
the verdict but null the timestamp); decision rows, wrong-schema rows,
malformed rows and foreign kinds are skipped, never counted. The
evidence records only `{outcome, at}` — the reviewer's pool/family,
reasons and semantic detail stay audit-side and never join. The fold's
`crossReviews` option joins each outcome's `cross_review` through the
job's newest unambiguous canonical PR claim — the same claim rule the
merge-queue join applies, so a contested or foreign URL never
resolves — and review rows for PRs no outcome claims unambiguously
join nothing and never create outcomes. The join is fill-only
diagnostic context: it explains what the review gate recorded while
the merge verdict stayed unrecorded, and it never feeds routing,
ranking, admission or weight math. The read degrades independently:
`RouterOutcomeRead.cross_review_state` reports its health and
`cross_review_truncated` marks a cut tail; anything but `read` leaves
every `cross_review` null — unknown, never a guessed verdict, and an
empty readable ledger means zero recorded joins rather than missing
coverage. `passk` is the
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
to no join; `authorityEvidence: null` skips the authority join only and an
explicit array is used as given. A second, independent revert source joins
under the same claim rule: `improve/revert-outcomes.jsonl`, the bounded
append-only ledger `phm fleet reverts --record` writes from its
72h-window git-history scan. Its newest record per `owner/repo#n` key
decides — a later detection whose `relandedBy` is set clears the key —
and `RouterOutcomeRead.revert_ledger_state` reports the ledger's health
(`read`/`missing`/`unreadable`/`too-large`); anything but `read`
contributes no keys, so corrupt evidence never marks a merge reverted.
Revert evidence is sticky-true like
metrics-ingest, so a recorded revert is never contradicted by a later
`reverted:false`; it is `null` when neither source records anything
either way. Jobs rows also fold four productivity verdicts, newest
explicit row wins: `empty` (the recorded no-diff boolean), `exit_code`
(the worker's recorded exit status, negative signal exits included),
`failure_class` — the recorded failure classification, resolved
`failure_class`, then `failure_reason`, then `pool_error` on a finish row
(snake_case before camelCase within each, the precedence the skill-nudge
ledger reader shares) or the fixed `reason` on a `launch_failed` row
whose `action` is `give_up` — the dead launch's recorded cause, since
dispatchd drops the line when the retry budget is spent or the failure
is permanent; `action: 'retry'` receipts are transient backoff and
`launch_terminal` rows fire on requeues and skips, so neither mints a
classification — and accepted only as bounded identifier-shaped
labels; anything else is skipped, never recorded raw — and `empty_class`,
the finish row's recorded empty-diff classification in dispatchd's closed
`classify_empty` vocabulary (`no_diff`/`error`/`unknown`, snake_case
before camelCase; unrecognized spellings skipped, never recorded raw).
dispatchd writes
`failure_class` only for the devin pool, so the fallbacks carry every
other lane's classified cause (`launch_timeout`, `provider_*`,
`agent_exit_nonzero`, `exit_status_missing`, pool errors like
`rate_limit`), and the give_up reason carries the launch vocabulary
(`launch_timeout`, `local_backend_unavailable`, `authentication`,
`resource_exhausted`, `provider_unavailable`, `launch_interrupted`,
`launch_script_error`). All stay `null` when no jobs row recorded them —
the fold never infers a finish verdict from merge state, PR URLs or
event names.
Finish rows also fold dispatchd's `job_usage` block and
`job_diff_metrics` figures, newest explicit row wins like `wall_s`:
`acus` (the Devin lane's billed ACU spend — a different unit than
`cost_usd`, never summed with it; `acus`/`acus_consumed`/`acusConsumed`
spellings), the token breakdown `tokens_in`/`tokens_out`/
`tokens_cache_read`/`tokens_cache_write` (snake_case before camelCase),
the bounded identifier labels `usage_source` (the recorded measurement
path — `devin-sessions-db`/`claude-result-json`/`tokens-line`) and
`usage_missing` (the recorded capture-gap reason — `devin-*`/`claude-*`/
`tokens-line-*`), and the recorded diff size `diff_files`/`diff_lines`
(`diff_lines` stays `null` when untracked files made the line total
unmeasurable — recorded unknown, never a partial sum). All stay `null`
when no jobs row recorded them.
Batch sessions fold per member like the sibling fleet readers:
`RQ-BATCH-*` session rows (launch, finish, session-aggregate usage) are
infrastructure evidence counted in `RouterOutcomeFold.session_rows` —
they never mint outcomes and never claim PR URLs — while a member's
`task_outcome` event row supplies its recorded end-of-session word in
dispatchd's closed `batcher.OUTCOMES` vocabulary (`done`/`skipped`/
`failed`/`deferred`/`unreported`, `event`/`type`/`kind` = `task_outcome`,
word under `outcome`; unrecognized spellings and every other row's
`outcome` field skipped, never recorded raw). Members get no per-member
finish row, so their finish verdicts and usage stay `null` rather than
split from the session aggregate; `task_outcome` is the member's only
recorded productivity verdict and stays `null` for solo jobs.
Node session-pool rows (`fleet.session-pool.v1`,
src/core/fleet/session-pool.ts) resolve their job identity by the
producer's own contract: `job` is the unique per-attempt id
(`<sessionId>:<n>` — session machinery, never a job identity) and
`jobId` the logical queue id the attempt worked, so only `jobId` keys
an outcome under the same `job`/`job_id`/`jobId`/`id` dialect every
other row uses — the attempt id never mints a phantom outcome, a
queue job's launch/finish rows fold into one outcome whether one
session or a later retry ran them, and rows carrying `job` without
`jobId` stay unattached. `session_start`/`session_stop` carry no job
fields and never mint outcomes; `session_rotate`, `launch` and `finish`
carry the just-pulled task's ids and fold under the same rule.
Node-runner finish rows (`phm-node-runner.v1`,
src/core/drive/nodes/runner.ts — the multi-Mac node pool's pack
executor) resolve job identity by the same dual-id contract: `job` is
the unique per-claim id (`<jobId>:<token>` — the claim's fencing token
makes every attempt distinct) and `jobId` the logical node-queue id the
claim worked (`ready:<job>:<attempt>`, the node bridge's routerJobId),
so only `jobId` keys an outcome — the claim-scoped id never mints a
phantom outcome and a retried claim's finish rows fold into the same
outcome. The row's `outcome` is the runner's closed terminal verdict
vocabulary — `succeeded`/`fenced`/`failed` — an execution verdict for
the offloaded pack job, never a merge phase (node-pack jobs produce
result artifacts, not pull requests), so it folds as
`node_outcome`/`node_id`/`node_pack`: the verdict word plus the row's
`node` and `pack` in the bounded identifier shape (the producer's
validId alphabet at the file's standard bound; a malformed value drops
to null without discarding the recorded verdict). The row counts only
on the schema with an in-vocabulary `outcome`; the newest recognized
finish row replaces the triple wholesale, claim and leader fencing
tokens never join, and all three stay `null` when no recognized runner
row named the job — unknown, never "never ran on a node".
`lane_hint_blocked_by` is the dispatch claim's recorded lane-hint
blocking codes — the third field of the claim's lane-override record.
A solo `claim` row that left its hinted lane spreads the work market's
`preferred_lane_blocked_by` here: the rejected preferred lane's
`reason_codes` (`quota_exhausted`, `saturated`, `held`,
`provider_backoff`, `hysteresis_*` and the rest of the market's closed
vocabulary) or `[]` when the preferred lane was unknown to the market
or merely outranked rather than rejected (`unknown_preference`,
`resource_fit`, hysteresis-held fallbacks). `batch_claim` rows never
carry the field — a member that moved lanes with its session has no
market blocking record — so it stays `null` there, unknown, never
`[]`. The list joins only alongside a well-formed `lane_override` on
the newest `claim`/`batch_claim` row under the same newest-claim-stands
rule the override pair follows: a later on-hint claim clears it, a
malformed reason or hint skips the row, and rows of every other event
never touch it. Entries join only in the bounded lowercase
reason-code shape, deduplicated in recorded order and capped; a
non-array value or a list whose entries are all unrecognizable reads
as unrecorded (`null`), while a recorded empty list stays `[]` — the
market's own "nothing blocked it" verdict, distinct from missing
evidence.
`skipped`/`skip_reason`/`skip_code` are the skip gate's recorded launch
decline: dispatchd's `empty_gate` and precheck skip paths write
`skipped_empty` rows (with `precheck_skip` the spelling the sibling
fleet readers — job-outcomes, empties, slot-yield, leader-batches —
honor for the same receipts), and a row whose `applied` is not `false`
marks the standing decline — the fleet chose not to launch the job.
A dry-run receipt (`applied:false`) records the job still launched, so
it never mints a decline and supersedes a standing one to `false`; a
later `claim`/`batch_claim`/`launch` dispatch row supersedes it the
same way, while `finish`/`publish`/`outcome` rows belong to attempts
already decided and never touch the verdict. The newest skip row
replaces the standing record wholesale: `skip_reason` is its recorded
label — `reason`, then `empty_reason`, then `skip_reason`, with a
bounded-string `code` as the last resort, accepted only in the bounded
identifier-label shape and skipped rather than replaced by a fallback
when malformed — and `skip_code` its recorded gate code
(`code`/`precheck_code` as a non-negative safe integer; a string `code`
joins `skip_reason` instead). `dupcheck_skip` never joins — it is the
detailed dupcheck receipt whose paired `skipped_empty` row already
carries the canonical decline. All three stay `null`/`false` when no
skip receipt stands: `skipped` is `null` before any skip or dispatch
row, `false` once superseded, and `skip_reason`/`skip_code` are `null`
whenever `skipped` is not `true` — a decline distinct from the finish
row's measured `empty` no-diff verdict, the batch member's
`task_outcome` word, and the terminal no-op verdict `noop` folds.
`deferred`/`defer_reason`/`defer_repeat_of` are the fleet's recorded
keep-queued launch verdict: dispatchd's launch loop writes
`dispatch_deferred` when a ready line's request digest is already
covered by an earlier job's claim (`duplicate-request`, with the
covering job under `repeatOf`), `recut_admission` rows carry the recut
coverage verdict under `action` — `defer` marks the standing deferral
(`recut-in-flight`, the in-flight or merged prior under `repeatOf`)
while `ready`/`skip` resolve the blocker — and `precheck_parked` marks
the precheck park (the bounded park reason under `reason`, no cover).
The verdict competes with the other launch-decision rows on row order
like the skip decline: the newest keep-queued receipt stands until a
later `claim`/`batch_claim`/`launch` dispatch row or a skip-gate
decline — the fleet's newer recorded decision about the same queued
job — supersedes it to `false`, while `finish`/`publish`/`outcome`
rows belong to attempts already decided and never touch it; an
unrecognized recut `action` or non-defer event leaves it alone.
`defer_reason` is the newest defer row's recorded label (`reason`,
then `defer_reason`, in the bounded identifier-label shape —
`duplicate-request`, `recut-in-flight`, the precheck park reasons —
malformed spellings skipped, never recorded raw) and
`defer_repeat_of` its recorded covering job (`repeatOf`/`repeat_of` in
the bounded job-id shape; a `precheck_parked` row parks the job itself
and records none). Both are replaced wholesale by the newest defer
row and cleared with the verdict; all three stay `null`/`false` when
no keep-queued receipt stands — distinct from `skipped` (the skip
gate's decline), `task_outcome` `deferred` (a batch member's requeue
word) and queue waits that write no receipt.
`noop`/`noop_reason`/`noop_repeat_of` are the fleet's recorded terminal
no-op verdict: an outcome-phase row whose resolved phase sits in the
canonical empty family the sibling readers share — `DONE-NOOP` (the
live spelling: dispatchd's already-merged/terminal-target admission,
recut-skip and repair-freshness verdicts and restock's precheck
retirements write `{event:'outcome', state:'DONE-NOOP'}` with
`launched:false` and the recorded `reason`), plus the defensive
`EMPTY`/`EMPTY_DONE`/`SKIPPED-EMPTY`/`NOOP` spellings
(skill-nudge's `EMPTY_PHASES`, lane-yield-verdict/weight's
`EMPTY_PHASES`, queue job-outcomes' `TERMINAL_EMPTY` and
launch_precheck's `_TERMINAL_EMPTY` vocabulary; `SKIPPED` stays out so
a batch member's `task_outcome` word never mints a job verdict). It
is the fleet's recorded "no publishable work needed" decision —
distinct from `empty` (the finish row's measured no-diff; these jobs
never ran), `skipped` (the skip gate's decline), `deferred` (kept
queued) and the merge lifecycle (`merged` stays `null`; the reward and
retro feeds deliberately never count `DONE-NOOP` as a merge
resolution). The verdict competes with the other launch-decision rows
on row order: the newest empty-family row marks it with its recorded
reason — `reason`, then `empty_reason`, then `noop_reason`, in the
bounded identifier-label shape (`already-merged`, `target_pr_merged`/
`target_pr_closed`/`target_pr_conflicts_resolved`/
`target_pr_checks_resolved`, `recut-already-merged`, the precheck
retirement labels; malformed
spellings skipped, never recorded raw) — and cover (`repeatOf`/
`repeat_of` in the bounded job-id shape, the recut verdict's prior
attempt; the admission, repair-freshness and restock rows record none),
while a standing `skipped`/`deferred` resolves to `false` since the
terminal verdict is the fleet's newest recorded decision about the
queued job (a `null` skip/defer stays `null` — no receipt was ever
recorded). Every newer launch-decision receipt — a
`claim`/`batch_claim`/`launch` dispatch, a skip-gate row, a
keep-queued receipt or a `recut_admission` verdict — supersedes it to
`false`; `finish`/`publish`/outcome rows of other phases and
non-decision events never touch it, and the newest no-op row replaces
reason and cover wholesale. All three stay `null` when no empty-family
row named the job — unknown, never a guessed verdict.
`handoff_trigger`/`handoff_lane`/`handoff_target` are the fleet's
recorded session-handoff advisory — dispatchd's
`session_handoff_advisory` rows (`session-failover.v1`, the
contrib/mac/session_handoff.py producer mirrored in the fold). The
producer's closed trigger vocabulary has two verdicts:
`rate-limit`, the once-per-attempt receipt dispatchd appends to
metrics/jobs.jsonl through `metric()` when a run's log tail matched
a usage-limit pattern and the attempt failed or produced no usable
work — the provider wall that names the lane whose run died,
distinct from the finish row's own exit/empty measures since a
walled run can exit cleanly and still produce nothing publishable —
and `quota-exhausted`, the pending-job verdict dispatchd writes
through `market_metric()` to metrics/work-market.jsonl when the
job's lane measured zero quota, carrying the market's chosen lane as
`target` — the market-side copy joins back through the
`foldMarketHandoffAdvisories` read under the `market_state` health,
superseding the jobs-ledger triple only when its recorded `ts` is
strictly newer than the standing jobs-ledger advisory's (no jobs
advisory fills the triple; an unorderable jobs advisory leaves the
jobs verdict standing). This fold keeps the producer's full
vocabulary so a quota-exhausted row landing in the jobs window
still joins under the same rules. The row counts only on the exact
`session-failover.v1`
schema and `session_handoff_advisory` event name (the
`event`/`type`/`kind` alias set) with a `trigger` inside the
producer's closed vocabulary; `handoff_trigger` joins only those two
labels, `handoff_lane` the advisory's `lane` and `handoff_target` its
`target` each only in the bounded lane-identifier shape — a malformed
trigger skips the row entirely, malformed lane/target values drop to
`null` without discarding the recorded trigger, and nothing is ever
recorded raw. The newest recognized advisory row replaces the triple
wholesale; the advisory is attempt evidence, not a launch decision,
so rows of every other event — including later `finish`/`claim`
receipts — leave it standing. All three stay `null` when no advisory
row named the job: the retained window recorded no provider-wall
verdict, which is unknown, not "no wall ever".
`provider_wall_trigger`/`provider_wall_pattern`/`provider_wall_lane`
are the fleet's recorded provider-wall lane hold — dispatchd's
`autobackoff_hold` receipts (jobs.jsonl rows the usage/quota and
auth backoff scanners append through `metric()` when a finished
run's log tail matched a provider error pattern and the lane was
held). A hold only lands on a failed or no-work run — the auth
scanner additionally requires its `auth_failures` streak — so the
receipt is the fleet's confirmed provider-wall verdict for the
attempt, covering the auth walls the session-handoff advisory never
sees and the usage walls whose hold landed where no advisory did
(an outcome-unreadable run, a still-standing earlier hold). The row
counts only on the `autobackoff_hold` event name (the
`event`/`type`/`kind` alias set, case-folded like the sibling
verdict folds) with a `pattern` id in the bounded
identifier-label shape — the payload field every producer hold row
carries; `provider_wall_trigger` joins in the fold's closed
two-label derivation (`usage-limit` for the usage/quota scanner's
pattern family, `auth-failure` for the auth scanner's — a recorded
`auth_failures` count marks the auth streak holds outright, and the
router keeps its own copy of the producer's `AB_RX`/`AB_AUTH_RX`
pattern tables so a producer-side rename can never leak an
unbounded label), `provider_wall_pattern` records the bounded
pattern id verbatim, and `provider_wall_lane` the held lane in the
bounded lane-id shape. An unrecognized pattern still records the
hold with trigger `null` rather than skipping the receipt or
guessing a family; a malformed lane drops to `null` without
discarding the hold; the `autobackoff_skip`/`authbackoff_skip`
helper-unavailable receipts — scans that recorded no verdict —
never join. The newest recognized hold row replaces the triple
wholesale; the hold is attempt evidence, not a launch decision,
so rows of every other event — including later `finish`/`claim`
receipts — leave it standing. All three stay `null` when no hold
row named the job: the retained window recorded no confirmed
provider wall, which is unknown, not "no wall ever".
`pool_kind`/`pool_mem_free_pct`/`pool_swap_gb` are the fleet's
recorded slot-throttle detection — dispatchd's `pool` receipts
(jobs.jsonl rows the per-tick `ratelimited()` scan appends through
`metric()` when a launched job's recent error-log tail matches a
provider-limit pattern; the contrib/mac/dispatchd.py producer
mirrored in the fold). The row is scan-time evidence, not a launch
or terminal verdict: the detector fires on a log-tail pattern match
for any job whose `.base` still stands, once per (job, class) via
the producer's `.seen` markers, so a recovered run, an in-flight
run and a finished run whose finish row never recorded `pool_error`
all carry the same receipt. `pool_kind` joins only in the
producer's closed CLS vocabulary — `credits_exhausted`,
`usage_limit`, `model_capacity`, `rate_limit`, the same classes the
finish row's `pool_error` and the friction ledger's quota-error set
share — `pool_mem_free_pct` the host free-memory percentage (only
inside [0, 100]) and `pool_swap_gb` the host swap figure (only
non-negative) the detector captured at detection time, each a
bounded number whose malformed value drops to `null` without
discarding the recorded class. The row counts only on the `pool`
event name (the `event`/`type`/`kind` alias set, case-folded like
the sibling verdict folds) with a `kind` inside the vocabulary; a
`kind` outside it skips the row entirely, never recorded raw. The
newest recognized pool row replaces the triple wholesale; the
receipt competes with nothing, so rows of every other event leave
it standing. All three stay `null` when no pool row named the job:
the retained window recorded no throttle detection, which is
unknown, not "no throttle ever".
`merged` reads the jobs-ledger outcome dialect the sibling fleet readers
share: a terminal phase across
`phase`/`state`/`outcome`/`status`/`result`/`conclusion`, or a `merged` /
`closed` event name when no phase field resolves (a resolved phase stays
authoritative; `mergedAt`/`closedAt` stay the preferred terminal stamps),
with the `merged` boolean as before; every other spelling stays `null`.
`ttm_s` is the recorded opened-to-merged seconds (`ttm_s`/`ttmS`, the same
jobs-ledger dialect merge-pace, merge-graph, throughput, eval-report and
job-activity read): the fold takes it only from the row that last won the
merge verdict, only when that verdict is a merge, and the newest winning
row replaces it wholesale — a later close clears it and a merge row
without the field leaves it `null`. It is never derived from `wall_s` or
timestamps. `queue_wait_s` is the recorded queue-admission wait derived
once per job from the retained rows' boundary stamps — the latest
`enqueue`/`enqueued`/`queued` arrival at or before the job's earliest
`claim`/`batch_claim`/`launch` dispatch, in seconds across the
`ts`/`timestamp`/`at`/`time` dialect (the same boundaries job-latency's
queue_wait phase and reward-feed's dispatch set pair). A requeued job's
later arrivals never move its first-dispatch wait; a job with no recorded
arrival before its first dispatch — a direct dispatch or a batch member
claimed only through its session — stays `null`, unknown, never zero and
never another phase's duration. `ci_wall_s` is the recorded CI wall
seconds derived once per job from the same `ci_start`/`ci_complete`
boundary event pair the reward feed's ciWallMs, job-latency's `ci`
phase and visit-sync's check boundaries already read: exactly one start
and one complete stamp across the retained rows — identical repeated
stamps dedupe so a replayed append cannot fake ambiguity — across the
same `ts`/`timestamp`/`at`/`time` dialect, with the complete stamp not
preceding the start. A missing boundary, reversed stamps or a repeated
pair — a CI re-run — leaves the job absent so its outcome keeps `null`,
unknown, never a partial guess and never another phase's duration.
`publish_wait_s` is the recorded publish-station wait derived once per
job from the same `finish`/`publish` boundary pair job-latency's
`publish_wait` phase and visit-sync's publish station already read:
exactly one finish stamp and one publish stamp across the retained
rows — identical repeated stamps dedupe so a replayed append cannot
fake ambiguity, a retried attempt's second finish or a republish's
second publish makes the job ambiguous — across the same
`ts`/`timestamp`/`at`/`time` dialect, with the publish stamp not
preceding the finish. A resolved terminal phase stays authoritative
over the event name, so the outcomes reconciler's copied publish row
re-stamped `MERGED`/`CLOSED` is verdict evidence at verdict time and
never a second publish, while a `PUBLISHED` phase on any row — the
publish claim the reconciler consumes — counts with or without a
publish event name. A missing or repeated boundary, reversed stamps
or publish-before-finish ordering leaves the job absent so its
outcome keeps `null`, unknown, never a partial guess and never
another phase's duration.
`lane_hint`/`lane_override` are the
dispatch claim's recorded lane override: a `claim` or `batch_claim` row
writes the pair when the launch left its hinted lane — `lane_hint` the
preferred lane left (the market's `preferred_lane` on solo claims, the
member's own lane on `batch_claim` rows) and `lane_override` the
recorded reason in the work market's `resource_fit` /
`unknown_preference` / `preferred_lane_fallback` vocabulary or the
literal `batch_session` for a member that moved lanes with its session.
The newest claim row stands — a later claim that ran on its hint clears
an earlier override — and rows of every other event never touch the
pair. `lane_override` joins only in the bounded lowercase code shape and
`lane_hint` only in the bounded lane shape the fleet unfed claims fold
accepts; a malformed value is skipped, never recorded raw, and an
override reason without a recorded hint joins with `lane_hint` null.
Advisory `failover` receipts carry the same field names under a
different vocabulary (`failover_*` codes, hint = the failed lane) and
never join. Both stay `null` when no claim row recorded an override.
`tokens_total` is the finish row's recorded usage total
(`tokens_total`/`tokensTotal`): newest explicit row wins like `cost_usd`
and `wall_s`, and it
stays `null` when no jobs row recorded one — never derived from cost or
event names. The fold is read-only and advisory: it
never routes, ranks, tunes or writes.

`router/controller-quality.ts` exports `readControllerQuality({runsDir?})`,
`CONTROLLER_QUALITY_STATE_RELATIVE`, `CONTROLLER_QUALITY_RECEIPT_SCHEMA`
and the `ControllerQualityRead`/`ControllerQualityReceipt`/
`ControllerQualityState` types. It reads the fleet controller's recorded
lane-quality verdicts — the `route.quality.v1` receipts dispatchd's
`outcome_quality` pass stores as `quality_receipts` inside the atomic
`<runsDir>/queue/fleet-controller.json` state document — under the same
bounded regular-file rules as `readLedgerFile` (1 MiB limit, symlinks
refused). `runsDir` resolves like `readRouterOutcomes` (ASHLR_RUNS_DIR,
then `~/.ashlr-runs`) and must be absolute when given. The read state is
the shared `LedgerReadState` plus `'invalid'`: non-JSON content, a
non-object document, or a `quality_receipts` member that is not an array
reports `invalid`; a missing member means the controller never recorded
verdicts and reads as `read` with an empty list — a real measurement,
distinct from an absent or broken file. Each receipt must carry the v1
schema, a lane-shaped id and a finite `ts` to join at all; `score`,
`ci_adverse_delta`, `from`/`to` join only inside their recorded ranges,
`resolved`/`target_from`/`target_to`/`decided_at` only as bounded counts
or timestamps, `report_at` only as bounded text, and `reason`/`mode` only
inside the producer's closed vocabularies — anything else joins as `null`,
never echoed raw. When the file records a lane twice the newest `ts` wins
(ties go to the later row) and the result is sorted by lane, capped at 64
distinct lanes; `invalid_rows` counts rejected rows. The read feeds the
advisory `router.weight-proposals.v1` report: `buildRouterWeightProposalReport`
accepts `opts.controllerQuality` and reports `controller_quality_state`
(`'unreported'` when no read was supplied — distinct from `missing`),
`controller_quality` (the receipts, `null` unless state is `read`) and
`controller_quality_invalid_rows`. `phm fleet router-weights` performs the
read itself (a controller-read failure degrades to `unreadable`, never a
command failure) and renders the verdicts as advisory context alongside
the proposals. Nothing here routes, weights or applies anything.

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

`router/typed-decisions.ts` exports `foldTypedDecisions(text, path, truncated)`
and `readTypedDecisions({runsDir?, limit?})`, producing a
`route.typed-decisions.v1` digest of the dispatcher's typed-routing audit
journal `<runsDir>/metrics/route.explain.jsonl` (`TYPED_DECISIONS_LEDGER_RELATIVE`).
The read retains the newest `TYPED_DECISIONS_LEDGER_LIMIT` (8 MiB) via
`readLedgerTail` — symlink and non-file refusals included — and reports
`state` (`read`/`missing`/`unreadable`/`not-file`), `truncated`, `records`,
`invalid_rows`, `observed`/`unavailable` counts, top-eight `lanes`,
`models` and `reason_codes` tallies, `{known, mean, max}` summaries for the
recorded `duration_ms`, `attempts` and `candidate_count` metrics, and the
`oldest_ts`/`newest_ts` epoch-second window (null when no valid rows). A row
counts only under the exact `route.explain.v1` producer contract — schema,
`route.explain` event (event/type/kind alias), `advisory: true`, finite
non-negative `ts`, `status` `observed`/`unavailable`, and for observed rows
a decision inside the producer's allowlist (bounded lane/model ids, the
effort/speed-tier enums, 1–16 in-vocabulary reason codes). Anything less is
`invalid_rows`, never a partial pick; malformed optional metrics stay
unrecorded (`known` counts well-formed figures only, means null when none
exist). Journal rows carry no job identity, so the digest is fleet-level
service evidence only. `explainRoutes(root, nowSeconds)` adds the digest as
`typed_decisions` on both the available and unavailable reports. Nothing
here routes, weights or applies anything. See
[typed routing](docs/ROUTING.md#dispatcher-observation).

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

The canonical types are exported from **`src/core/types.ts`** — import them, never redefine.
That file is an entry point; the declarations live by domain in `src/core/types/`
(for example `config.ts`, `engines.ts`, `run.ts`).
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
jobsTruncated?)`,
`foldRouteRejections(marketJsonl, nowMs, windowHours)` and
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
job `unresolved`, never a fabricated outcome. `foldRouteRejections` reads
the same collapsed decisions' `rejected_lanes` — every lane the market
refused each job, with its recorded reason codes — into the report's
`rejections` field (`available`, `decided`, `unrouted`, `lanes`,
`byReason`): `lanes` tallies rejected lanes per job with per-lane reason
counts, `byReason` counts each job once per reason across all its rejected
lanes, and malformed entries or codes are skipped rather than guessed. The optional `market` carries the
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
and `models` / `telemetry` gained optional keys; read `src/core/types/config.ts` and
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

## Lane target snapshot v1

`src/core/fleet/runs-lane-targets.ts` exports `readLaneTargets` and
`setLaneTarget`, returning `LaneTargetsV1` from `queue/slots.json`:

```ts
export interface LaneTargetRow {
  lane: string; target: number; floor: number; ceiling: number | null;
  held: boolean; heldReason: string | null; heldUntil: string | null;
  pausedFrom: number | null; lastChange: string | null; changedBy: string | null;
}
export interface LaneSkip { lane: string; reason: string }
export interface LaneTargetsV1 {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'missing' | 'degraded';
  lanes: LaneTargetRow[]; skipped?: LaneSkip[];
}
```

A null or omitted on-disk `ceiling` projects as `ceiling: null`, meaning no
fixed ceiling. Numeric ceilings must be nonnegative safe integers at or above
the floor. Target writes respect the floor and the smaller of the lane's
numeric `ceiling` and `hard_cap`, when present; without either cap there is no
fixed upper bound. Extra dispatcher fields are preserved.

Invalid lane rows are omitted from `lanes` and reported as `{lane, reason}` in
the optional `skipped` array, which is absent when no rows were skipped.
Per-row skips leave `sourceState: 'healthy'`; malformed or unsafe files still
report `degraded`, and missing files report `missing`. A malformed hold flag
or non-string global `last_change_by` makes the whole source unavailable.
Writes to a skipped lane fail with `LaneTargetError('unavailable')` (503).
`phm fleet lane-target --json` passes through this snapshot; text output shows
an unbounded ceiling as `none` and includes skipped-lane reasons.

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
read the jobs ledger only, keeping its newest bounded tail on oversized
ledgers and marking cut evidence degraded. Weekly defaults to 168 hours. The
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
`DriveNodes.jobOutcome(jobId, owner)` is the read-only counterpart `phm node
result` serves: a `JobOutcome` (`pending | running | completed | absent`) with
`result`, `completedBy` and `completedAt` for an accepted completion,
`claimedBy` for a live running claim and `producerWithdrawn` for a producer
fence. The owner match is `withdraw`'s, so another scope's job answers
`absent`; the read never mutates state or exposes fencing tokens.
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
`SessionThreadsMessage`, `SessionThreadsServes`, `SessionThreadsWork` and `SessionThreadsParts`,
and the pure `workOf(activity)`. It also exports the pure
`pickSessions(nodes, max)`, which returns `{kept, left}`: the sessions a
bounded read keeps, in the list's order, and a `SessionsLeftOut` count
(`running`, `ended`, `unknown`) of the rest. A list within `max` is kept
whole. A longer one gives up finished sessions first (longest silent first),
then failed ones, then ones whose state is neither running nor ended, and a
running one only when more than `max` are running; the leader is always kept.
`threadSessions(list)` returns that count as `left`, the read carries it as
`counts.unshown` (after `states`; all zero when nothing was left out), and
`leftOutWords(left)` gives the words the gap sentence uses ("3 running, 2
ended"). `findSessions` in `session-find.ts` picks its 120 the same way. `parts` is
`{sessionsRead, bus, activity, replies?, owner?, orders?}`, where `activity`
maps a job id to its activity read (null when that read failed, no key when it
was not asked for), `owner` is the Leader inbox, handed to the leader's and
every worker's thread and to no helper's, and `orders` is the order trace
(`OrderTraceV1`), handed to the leader's thread and to every worker's that has
a job, and `controls` is the job control file (`readonly JobControlLedgerRow[] | null`,
undefined when not asked for), handed to every thread whose session has a job.
`SessionThreadsV1.sources` is `{sessions, bus, owner, replies, orders, controls}`. Each entry is built by
`buildSessionThread`, so its session, summary, sources, gaps and `reply`
(the `SessionThreadReply` of `session-reply.ts`) equal the
single-session thread for the same records. Before `reply`, an entry carries
`control: SessionThreadControl | null`, the single thread's own answer (the
newest request for the session's job that was not refused; null when none
stands, for a session with no job, and when the control file was not read).
After `reply` comes `serves`:
`{key, at, source, text, truncated, jobs}` for a worker whose job the order
trace ties to a message of Mason's (the newest such message; `key` is shared
by every entry serving it, `at` is the inbox's Eastern minute, `text` is null
when the message is not among the inbox entries read, `jobs` counts every job
the trace ties to the message), otherwise null.
An entry's last key is `work: SessionThreadsWork | null`, built by
`workOf` from the job's activity read: `{commands, files, step}` with
`commands: number | null` (null when the log's commands were not read
healthy), `files: {count, added, removed, partial} | null` (null when no
change read answered, `partial` for a degraded one) and
`step: {event, summary, at} | null` (the newest recorded step; `at` null
when it does not parse). These are the values the summary's "commands seen,
files changed" and "Latest step" sentences state. `work` is null for a
session with no job, a job whose activity was not asked for and a failed
activity read.
Pull request outcome (additive): `work` opens with the key
`pr: SessionThreadPr | null`, `{state, mergeSeconds, at}` with
`state: 'merged' | 'closed' | 'open'`, `mergeSeconds: number | null` (the
ledger's `ttm_s`, opened to merged, whole seconds; null when not recorded
and for a state that is not merged) and `at: string | null` (the outcome
row's own time, null when it does not parse). The same key leads the single
thread's `work`. `src/core/fleet/session-pr.ts` exports the type, the pure
`sessionPr(activity)` (rows before the job's newest `launch` are set aside;
a recorded merge stands, otherwise the newest row answers; null when no row
records an outcome), `prSentence(pr)`, `prWords(pr)`, `PR_SENTENCE_START`
and `SESSION_PR_STATES`. `summaryOf` appends `prSentence` after the "Latest
step" sentence when an outcome is recorded. In
`src/core/fleet/runs-job-activity.ts`, `FleetJobActivityEventEntry` gains
the optional key `pr?: FleetJobPrFate` (`{state, mergeSeconds}`), present
only on a row `rowPrFate(row, event)` reads as an outcome: an `outcome` row
whose state is MERGED, CLOSED or OPEN, or a `merged` or `closed` event. An
event entry's `summary` may now also carry `state=` and `ttm_s=`.
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
Output (additive): `parts` gains optional `output`
(`SessionThreadOutputRead | null`: `source`, `lines`, `truncated`, the shape
`scanJobLog` returns), messages gain the kind `output` (key `output`, the
newest `THREAD_OUTPUT_LINES` non-blank lines of the session's job log, each
cut to `THREAD_OUTPUT_LINE_CHARS`), `sources` gains a last key `output`, and
the `latest` message is left out when the output already ends with it. The
module exports `sessionOutputLines(lines)` and both limits;
`session-thread-read.ts` exports `readSessionOutput(job)` and
`readSessionThread` takes an injectable `readOutput`, asked for a session with
a job. In `fleet.session-threads.v1` a thread's `output` message keeps its
newest `THREADS_OUTPUT_LINES` lines; `SessionThreadsParts` gains optional
`output` (a map by job id), `threadSessions` entries gain `running`, and
`readSessionThreads` takes `readOutput`, asked only for running sessions.
Control (additive): `src/core/fleet/job-control.ts` exports the read-only
`readJobControlLedger({runsDir?})`, the control file as
`JobControlLedgerRow[]` (oldest first, one row per `requestId`, the last
status winning; a missing file is no rows), and
`src/core/fleet/job-control-types.ts` exports that row type
(`requestId`, `action`, `job`, `lane`, `status`, `reason`, `at`, `by`) and
`jobControlRecordLabel(row)`. In the thread, `parts` gains optional
`controls` (`readonly JobControlLedgerRow[] | null`), messages gain the kind
`control` (key `control:<requestId>`, side `record`, the newest
`THREAD_CONTROLS_SHOWN` requests for the session's job), `sources` gains a
last key `controls`, the summary gains a line for the request that stands,
and the document gains a last top-level key
`control: SessionThreadControl | null` (`action`, `lane`, `status` of
`requested` or `applied`, `at`): the newest request not refused.
`readSessionThread` takes an injectable `readControls`, asked for a session
with a job. `fleet.session-threads.v1` reads the control file once for the
whole document when a shown session has a job (`readSessionThreads` takes an
injectable `readControls`): each such entry carries the same `control`,
control messages and `sources.controls` as its single thread, and a failed
read is `sources.controls: 'unavailable'` with one line in `gaps`.
Depth (additive): `session-thread.ts` exports `SessionThreadDepth`
(`'recent' | 'full'`), `SESSION_THREAD_DEPTHS`, `SessionThreadLimits` and
`THREAD_LIMITS` (the limits for each depth; `recent` is the constants above).
`buildSessionThread(list, id, parts, now, depth = 'recent')` takes the depth
as an optional fifth argument and `sessionOutputLines(lines, shown =
THREAD_OUTPUT_LINES)` the number of lines to keep. The document gains two
last top-level keys: `depth` and `deeper: boolean` (true only for a
`recent` thread in which a limit left out something `full` would show).
`SessionThreadReadOptions` gains `depth`, and the default reply read asks
for one reply more than the depth shows. `cmdSessionThread(args, read)`
accepts `--all` and calls `read(id, 'full')` for it, `read(id)` otherwise;
`SessionThreadRead` is `(id, depth?) => Promise<SessionThreadV1>`, and the
route accepts `depth=recent|full` at most once, passing `'full'` on only
when asked. `renderSessionThreadText` adds a note naming `--all` when
`deeper` is true.
Work (additive): the document gains a top-level key between `gaps` and
`reply`, `work: SessionThreadWork | null`: `{commands, files, step}` as
described for an entry of `fleet.session-threads.v1` above, null for a
session with no job, a job whose activity was not asked for, a failed
activity read and an unknown id. `session-thread.ts` exports the type and
the pure `sessionWork(activity)` that builds it; in `session-threads.ts`,
`SessionThreadsWork` is now an alias of that type and `workOf` of that
function, so an entry and its single thread give the same answer. The last
four top-level keys stay `reply`, `control`, `depth`, `deeper`.
Task (additive): the document gains a top-level key between `summary` and
`messages`, `task: SessionThreadTask | null`, and each entry of
`fleet.session-threads.v1` gains the same key in the same place.
`src/core/fleet/session-task.ts` exports the type (`{line, from,
truncated}`), `SessionTaskFrom` (`'title' | 'queue' | 'opening'`),
`SESSION_TASK_FROM`, `TASK_LINE_CHARS` (160) and the pure
`sessionTask(activity, jobId?)`, `briefPastContext(text)` and
`taskWords(task)`; `session-thread.ts` re-exports `sessionTask` and the type. `sessionTask` quotes the first
non-blank line of the job's brief after the dispatcher's fleet view
(`briefPastContext` removes a leading `## CONTEXT` … `## END CONTEXT` block
and returns null when it never closes): a markdown heading gives
`from: 'title'` with its marks, and the job's own id in brackets at its end,
removed; a router envelope line ("Job <id> (…). Task from the Ashlr router
queue, verbatim:") followed by that job's queue row `<id> (<attrs>): <task>`
gives `from: 'queue'` and the row's task (a `DEPENDENCY GATE:` line between
them is skipped); any other line is carried as written with
`from: 'opening'`. It
returns null without an `ok` brief or a line to quote, and the builders give
null for a session with no job. `renderSessionThreadText` and
`renderSessionThreadsText` print `taskWords` ("Task: …" or "Brief opens: …")
under the session's line. In `fleet.session-threads.v1` a `brief` message
whose text opened with a closed fleet view starts after it, labelled
"Brief, after its fleet view" with `truncated` true.
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

## Session find (`fleet.session-find.v1`)

`src/core/fleet/session-find.ts` exports the pure
`buildSessionFind(list, parts, words, now)`, `findWords(query)`,
`findSessions(list)`, `renderSessionFindText(read)`, `SESSION_FIND_SCHEMA`,
`FIND_SESSIONS_MAX` (120), `FIND_HITS_SHOWN` (5), `FIND_TEXT_CHARS` (240),
`FIND_QUERY_CHARS` (200), `FIND_WORDS_MAX` (8) and the types `SessionFindV1`,
`SessionFindResult` and `SessionFindHit`. `parts` is the `SessionThreadsParts`
the session threads builder takes. Key order: `schema`, `generatedAt`,
`words`, `filter` (`lane`, `repo`, `live`), `counts` (`sessions`, `searched`,
`found`), `results`, `sources` (`sessions`, `bus`, `owner`, `orders`), `gaps`.
A result: `session`, `summary`, `hits`, `hitCount`, `messageCount`. A hit:
`key`, `kind`, `side`, `label`, `at`, `text`, `truncated`. Each session is
searched as its `full` depth thread, after that thread is scrubbed.
`src/core/fleet/session-threads-read.ts` exports `readSessionFind(query,
options)`, `readSessionFindParts(options)` and `SessionThreadsPartsRead`,
with the injectable reads `readSessionThreads` takes. `src/cli/sessions.ts`
exports `cmdSessionFind(args, read)` for
`phm sessions find <words> [--lane <lane>] [--repo <repo>] [--live] [--json]`
(exit 0 read, 1 list unreadable, 2 usage).
`src/core/verse/fleet-session-find-api.ts` exports
`createFleetSessionFindApi(read)`, `defaultSessionFindRead(readParts)`,
`handleFleetSessionFindApi` and `SESSION_FIND_PATH` for
`GET /api/verse/fleet/control/session-find?q=<words>` (read session required;
200, 400, 401, 405, 503). It adds no source and writes nothing. Fields are
listed in `docs/FLEET-API.md`.

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
label a `note`/`context` body carries (null for every other kind and shape),
`busBodyResultOutcome(body)`, the read-side predicate that returns the
`outcome` a `work.result` body reports (null for every other kind and
shape — a `work.release` body's own `released`/`completed` vocabulary stays
out), and the exported `repoSlugSchema` — the `owner/name` slug `work.post` and
`workJob` enforce and `busWorkFeedRepoKey` validates `--repo` feed filters
against. `note`/`context` bodies may also carry `inReplyTo`, the printable
envelope-id citation naming the message they answer — the same field
`postBusReply` and `comms bus post --reply-to` stamp and `busReplyCitations`,
the conversation projection and the pending-work sections already credit.
Routing labels, repo slugs and claim tokens reject trailing newlines; claim keys
reject ASCII controls including DEL. Claims grant no execution authority.

`projectBusWorkFeed(receipts: readonly unknown[], participants?: readonly Participant[], providerFor?: WorkFeedProviderFor, ownerKeyFor?: WorkFeedOwnerKeyFor)`
in `src/core/agents/bus-work-feed.ts` returns `WorkFeedResult`: either
`{status:'ok', feed:{v:2,jobs:WorkJob[]}, citations:ReadonlyMap<string,WorkFeedCitation>}`
or `{status:'refused',reason, receipt?}`. `WorkFeedCitation` is `{post, status, result?}` — the
wire ids of the retained `work.post` receipt that announced the job and of
the newest accepted `work.status` receipt (`status` is null while none has
moved it), plus — when a schema-clean `work.result` citing the job is
retained — `result`, a `WorkFeedResultCitation` (`{id, from, outcome,
reason?, receivedAt}`: the result receipt's wire id, reporting label,
outcome, optional bounded reason code and receipt time), keyed by job id,
so every job cites the envelopes its state came from; `agents bus show
<id>` resolves them. A `work.result` is reported outcome evidence only —
it never moves the job's status, detail or `updatedAt`, which only the
announcer's `work.status` does — and a malformed or orphan result is
ignored like any other non-feed body, never a projection refusal. `receipt` is a
`WorkFeedRefusalReceipt` (`{id, receivedAt, ttl}` — the wire id, receipt time
and TTL of the retained envelope whose processing refused the projection),
present on the body-level refusals (`invalid-body`, `missing-provider`,
`duplicate-job`, `owner-mismatch`) and absent when no single well-formed
receipt is the cause (`invalid-receipts`, `invalid-participants`).
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
posts and malformed work bodies refuse the projection. Latest cursor wins; `updatedAt` is its receipt time, and the job's optional `detail` is the newest status body's own `detail` text — a status that omits it clears the field so a stale reason never rides a newer state. Jobs retain post order.
This is a pure retained-snapshot projection, not a historical ledger or
authentication check. It performs no I/O, transport, claim mutation or execution. Existing v1
journals/readers remain unchanged; feed output is explicitly versioned `v:2`.
`readBusWorkFeed` (`src/core/agents/bus-work-feed-read.ts`) is the bounded
read-only reader over the local inbox; `GET /api/verse/agent-bus/work-feed`
(`src/core/verse/agent-bus-api.ts`, read session required) serves its
`BusWorkFeedReadResult` as `{v:1, ...}` — `ok` and `refused` answer
200 with the projection's own status, `unavailable`/`retryable`/`invalid`
answer 503. Its query is the feed CLIs' filter set: `claims=true` adds the
claims hold join, `open=true`/`claimable=true` imply it like the CLI flags,
and `status`, `job`, `repo`, `provider`, `tier`, `to`, `owner`, `since`,
`before`, `contains`, `channel` and `result` narrow the answer through the same
`projectBusWorkFeedView` the
CLIs use — jobs answer newest-first, `to`/`owner` resolve through the
server-side identity registry with exact-label fallback, `channel` is the
strict channel-name grammar prefix-matching `group:<channel>:` on the
announcement address, and `repo`,
`since` and `contains` share the CLI normalization. `limit` (1–200,
`BUS_WORK_FEED_LIMIT_MAX`) pages the filtered view through the shared
`sliceBusWorkFeedView`, reporting `matched`/`omitted`; absent, the whole
filtered view answers. Every parameter is a
single value validated by the shared `parseBusWorkFeedQuery`
(`src/core/agents/bus-work-feed-query.ts`) rules; repeated, unknown or
malformed parameters or values are a 400, and no caller-supplied root or
path is accepted — the read always uses the server-side fleet root.

`readBusWorkFeed({root?, now?, claims?, participants?, providerFor?, ownerKeyFor?})` in `src/core/agents/bus-work-feed-read.ts`
pages the bounded bus inbox without writes and returns ok/refused/unavailable/
retryable/invalid with receipt count and `asOf`; a `refused` result carries
the projection's `receipt` (`WorkFeedRefusalReceipt`) when it named one. On `ok` each job is a
`BusWorkFeedJob` (`WorkJob` plus `postId` — the announcing `work.post`
envelope's wire id — `statusId` — the newest accepted `work.status`
envelope's wire id, null while none has moved the job — and `result?` —
the citation's `WorkFeedResultCitation` when a `work.result` citing the
job is retained), so feed consumers can
`agents bus show` the receipts behind a job without a second scan; filters
keep the citation fields with their job. `runtimeProvider(identity)` is the exported newest-runtime provider
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
the table is unavailable. Holds cap at 1024 with `truncated` set. Open jobs
(`BUS_FEED_OPEN_STATUSES`) additionally carry `freeKeys`, `heldKeys` and
`claimable` — the same per-key hold coverage `work mine` reports, computed by
the shared `busWorkFeedJobHold`/`busWorkFeedHoldIndex` helpers in the same
module: `freeKeys`/`heldKeys` are null unless the coverage proves them and
`claimable` is true only on a provably free key, false only when every declared
key is provably held, and null whenever coverage is `truncated` or `unknown`.
Non-open jobs and reads without `claims` carry none of the fields, and the
human feed line prints `claimable=yes|no|unknown` on annotated jobs.
`BUS_FEED_OPEN_STATUSES` is the exported set of feed statuses that still mean
open for a worker (`queued`, `rescheduled`); the comms inbox pending-work view
and `claimBusWorkJob` share it so "claimable" means one thing.

`--open` on `phm fleet work-feed` and `phm agents bus work feed` implies
`--claims` and keeps queued/rescheduled jobs with declared claim keys. Complete
hold coverage excludes jobs whose every key is held; unavailable, absent or
truncated coverage keeps candidates visible with their existing claim
annotations. `--claimable` still requires proof of a free key. Both filters
compose with the existing feed filters. The unified inbox uses the same complete
hold coverage rule and reports incomplete coverage as degraded.

`coordinationRowBlocks(row, key)` in `src/core/agents/claim-store.ts` is the
exported read-only overlap predicate; acquisition and observation now share one
structural overlap rule. `projectBusWorkFeedView(result, filters?)` applies the
client-side feed filters (`{status?, jobId?, repo?, provider?, tier?, claimable?, open?,
since?, before?, toMatch?, ownerMatch?, contains?, channel?, result?}`),
newest-first order and per-job hold regrouping; `repo` is the lowercase
`owner/name` key `busWorkFeedRepoKey(repo)` normalizes a `--repo` argument to
(undefined for a non-slug, so callers reject it as usage) and matches a job's
announced repo case-insensitively, `provider` keeps jobs announced for that
provider, `tier` keeps only jobs whose `work.post` declared that dispatch
tier from `WORK_TIERS` — a job carrying no dispatch spec declares none and
never matches — `since` is an epoch-ms cutoff that keeps jobs whose `updatedAt` —
the newest accepted `work.status` receipt time, or the `work.post` receipt
time while no status has moved the job — is at or after it (the same
inclusive `>=` rule every `--since` bus read applies), `before` is the
exclusive `<` bound on the same `updatedAt` field so `since`/`before`
read one closed `[since, before)` window and `--before` at the oldest
shown job's `updatedAt` reaches the older jobs the newest-first
`--limit` cap hides, and `claimable:true`
keeps only jobs whose tri-state `claimable` is
provably true — a read without the claims join carries no field to match, so
it answers an honest empty view. `toMatch` is the predicate
`busWorkFeedPendingToMatcher(to, {root?})` builds, called with a job's `to`
address and its `owner` (announcement sender) label — the pending-work
addressed-to-agent rule `bus next`, `bus-follow`, handoff receive and
`agents bus inbox` share: the literal label, every label of one agent
identity, and `group:<channel>:<topic>` addresses of registry channels the
identity belongs to, minus channel posts the identity sent itself.
`ownerMatch` is the predicate `busWorkFeedOwnerMatcher(owner, {root?})`
builds over a job's `owner` (announcer) label — matching literally and
under every label of one agent identity the owner ref resolves to exactly
through `resolveAgent` (an unresolvable ref or unreadable
registry keeps exact-label matching for both). `contains` is the `--contains` needle normalized once
(lowercase, whitespace collapsed, trimmed) and matched as a case-insensitive
substring over the job's descriptive text — the announcement title, the
newest status detail and the declared dispatch scope/acceptance, each
scrubbed, single-lined and clipped at the same bounds `formatBusWorkFeedJob`
renders — so ids, claim keys, statuses and routing labels stay structured
fields with their own filters, never search text, and a secret-shaped value
is scrubbed before the match. `channel` keeps only jobs whose announcement
`to` carries `group:<channel>:` — the room's whole traffic under every
topic, the same raw address prefix `agents bus inbox --channel`, `channel
read` and `phm messages --channel` match; the value is the strict
channel-name grammar and matching needs no registry. `result` keeps only
jobs whose newest retained `work.result` citation carries that outcome —
one of the `WORK_RESULT_OUTCOMES` codes (`reserved`, `admitted`,
`complete`, `failed`) — reported evidence that never moved the job's
status, so a job with no retained result never matches. `sliceBusWorkFeedView(result, limit)` pages an
ok view newest-first to `limit` jobs (1–`BUS_WORK_FEED_LIMIT_MAX`, 200),
reporting `matched` as the true filtered total before the slice and
`omitted` as the rest while claims holds regroup under the shown jobs only;
non-ok results pass through untouched, and `BusWorkFeedPaged` is the ok
result plus those two counts. `formatBusWorkFeed(result)` renders the shared human
lines — each job as `<id> <status> "<title>" detail="<why>" owner=… to=… provider=… repo=… [tier=… scope="…" acceptance="…"] keys=<claim keys> claimable=… updated=… post=<postId> [status=<statusId>] [result=<outcome> [reason=<r>] by=<from> at=<iso> receipt=<id>]`
with title, detail, the optional dispatch spec and keys scrubbed, single-lined
and display-clipped (JSON keeps the full values; `detail=`, `status=`, the
dispatch fields and the result suffix appear only when present, `post=`
always) — the result suffix is `busWorkJobResultSuffix(job)`, the shared
helper `work mine`'s jobs and announced lines also append so every surface
renders the newest `work.result` report identically — a refused read's
footer adds `receipt=<id>` when the projection blamed a retained envelope,
and a paged read's footer adds `matched=N omitted=M` —
both feed CLIs use them, and both accept `--to <label>`, `--owner
<agent>`, `--job <id>`, `--repo <owner/name>`, `--provider <p>`,
`--channel <name>`, `--result <reserved|admitted|complete|failed>`, `--claimable`, `--since <15m|2h|1d|ISO>`, `--before <15m|2h|1d|ISO>`, `--contains <text>` and
`--limit <1-200>` beside
`--status`; `--claimable`
implies the claims join, `--since` and `--before` parse through the shared `parseSince`
grammar — `since` inclusive, `before` exclusive on `updatedAt` — `--limit` runs `sliceBusWorkFeedView` after the filters (absent,
the whole filtered view answers), and `--contains` takes a non-empty needle of at most
`BUS_WORK_FEED_CONTAINS_MAX` (512) characters, refusing unparseable or
overlong values as usage errors.
`phm fleet work-feed [--claims]
[--to <label>] [--owner <agent>] [--job <id>] [--repo <owner/name>]
[--provider <p>] [--channel <name>] [--claimable] [--since <15m|2h|1d|ISO>] [--limit <1-200>]` and
`phm agents bus work feed [--status] [--claims] [--claimable] [--to <label>]
[--owner <agent>] [--job <id>] [--repo <owner/name>] [--provider <p>]
[--channel <name>] [--since <15m|2h|1d|ISO>] [--limit <1-200>]` print the same
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
`busClaimJobRef(BusWorkFeedJob)` projects one announced feed job to the
`BusClaimJobRef` claim views share — id, announcer, status, title, newest
detail and the `postId`/`statusId` receipt citations.
`listBusClaims(BusClaimsListOptions)` (`root?`, `now?`, `key?`, `owner?`,
`excludeOwner?`, `contains?`, `since?`, `before?`, `origin?`, `jobs?`) is the
read-side companion: it returns the live coordination claims as
`CoordinationView` rows (fencing tokens never leave the store) with `source`
of `missing` (verified empty), `available` or `unavailable` (holds unknown,
not free), plus `asOf`. A malformed `key`, `owner`, `excludeOwner`,
`contains`, `origin`, `since` or `before` answers
`invalid`; a set
`key` narrows the list through the same `coordinationRowBlocks` overlap rule
an acquire applies, previewing the claims that would block it. A set `owner`
narrows to one holder: a handle, `agent:<handle>`, stable id or alias that
resolves through the identity registry matches every label of that identity;
an unresolvable ref or unreadable registry falls back to the exact owner
label, and the result's `owner` field (`ref`, resolved `identity` or null,
`registry` state) reports which mode applied so a label match is never
mistaken for identity proof. A set `excludeOwner` drops one holder under the
same identity-label rule, inverted — the result's `excludeOwner` field
reports the same resolution — so "what do the other seats hold" is one
read. A set `contains` keeps claims whose `key`, `sourceId` or
`repo`/`branch`/`path` target fields carry the needle as a case-insensitive
substring — the same `busReadContains`/`busReadContainsMatch` rule every
bus read's `--contains` applies. A set `since`/`before` keeps claims whose
recorded `started` — the lease's ISO acquisition time, stable across
renewals — lands inside the `[since, before)` window: `since` is the
inclusive `>=` bound and `before` the exclusive `<` bound every bus read's
time filters share, on the same field `work mine`'s claims section already
bounds; a claim whose `started` is null or unparseable — team, message and
board claims and pre-stamp resource rows keep no start time — is unknown
and never matches, the same "unknown stays out" rule every other section's
missing timestamp follows. A set `origin` narrows to one claim class —
`resource`, `message`, `team` or `board`, the `CoordinationOrigin` values
`COORDINATION_ORIGINS` lists (queue path observations are never live and
never list). With `jobs:true` each claim
gains an optional
`jobs` list of the announced work-feed jobs its keys block (`{id, owner,
status, title, detail?, postId, statusId}` per job — `postId`/`statusId`
the retained `work.post`/`work.status` receipt wire ids `agents bus show`
reads, the reverse of the feed's `--claims` hold join) and the
result's `feed` field reports the feed read state; a non-`ok` feed leaves
`jobs` absent so blocked work stays unknown, never an empty list.
`phm agents bus claim list [--key] [--owner] [--exclude-owner] [--origin] [--contains] [--since] [--before] [--jobs]`
prints it.
`claimBusWorkJob(BusWorkJobClaimOptions)` (`job`, `owner`, `leaseMs`, the
`BusClaimOptions` `root?`/`now?`, and optional `key?`/`id?`) is the job-level
companion to `claim acquire`: it reads the live work feed, requires the job
shown and open under `BUS_FEED_OPEN_STATUSES`, resolves one of the job's
declared claim keys (`queue:<jobId>` preferred, else the first declared; an
explicit `key` must be declared) and acquires through the same
`executeBusClaimBody` path, so overlap with every other claim origin still
decides in one place. `BusWorkJobClaimResult` echoes the announced job
(`{id, owner, repo, title, status, detail?, postId, statusId}` — `postId`/
`statusId` the feed job's retained `work.post`/`work.status` receipt wire
ids, so `agents bus show <postId>` reads the announcement behind every
outcome that found it) on every outcome that found it:
`acquired` carries the claim with the fencing token for its acquirer only,
`conflict` the holder without one, and
`invalid`/`refused`/`unavailable`/`retryable`/`full` carry a slug `reason`
(`invalid-job`/`invalid-owner`/`invalid-lease`/`invalid-key`, `unknown-job`,
`job-not-open`, `no-claim-keys`, `undeclared-key`, `work-feed-*`,
`claim-*`). `acquired` and `conflict` also carry `scope`
(`BusWorkJobClaimScope` `{source, holds}`): the live coordination holds on the
job's other declared claim keys — the targeted key excluded — each
`{claimKey, owner, leaseUntil}` found through the same `coordinationRowBlocks`
overlap the feed's `--claims` join applies, so a sibling `repo:`/`path:`/`pr:`
scope already held is visible in the claim result itself. `source` is
`missing`, `available` or `unavailable`; an unavailable table means sibling
holds are unknown, never an empty free set. A feed that cannot be read refuses
rather than claiming against a guessed job. `phm agents bus work claim --job <id> --lease-ms <ms> [--key]
[--owner] [--id]` prints it, exit 0 acquired, 2 invalid, 1 otherwise.
`phm agents bus claim message acquire|renew|release|complete --id <envelope-id>`
is the same message-id claim journal `fleet bus-claim`/`comms bus claim` drive:
`acquire` takes `--lease-ms` and `--owner` (default `PHM_AGENT_ID`), the other
verbs take `--token`; the result echoes the id, exit 0 on
acquired/renewed/released/completed, 2 on invalid, 1 otherwise.
`work.claim` acquire/renew run through `acquireCoordination`/`renewCoordination`
and `work.release` through `settleCoordination` on the one coordination table
with `origin:'resource'`; lease source ids are `agentbus:<opId>:<sha256-16 of
claimKey>` so an operation id retried on the same key replaces its own lease
while reuse on another key cannot relocate it. Claims coordinate only and grant
no execution authority; the token returns only to its acquirer.

`src/core/agents/bus-work-mine.ts` is the read-side per-agent digest behind
`phm agents bus work mine [<agent>] [--job <id>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority P0..P3] [--channel <name>] [--from <agent>] [--exclude-from <agent>] [--id <id>] [--in-reply-to <id>] [--body-kind <kind>]`. `readBusWorkMine(agent, options?)`
(`BusWorkMineOptions`: `root?`, `runsRoot?`, `mailboxHome?`, `board?`, `seats?`, `job?`, `contains?`, `since?`, `before?`, `priority?`, `channel?`, `from?`, `excludeFrom?`, `id?`, `inReplyTo?`, `bodyKind?`, `now?: () => number` frozen once
across all reads) returns `BusWorkMineResult`: `{status:'ok', agent,
asOf, job?, contains?, since?, before?, priority?, channel?, from?, excludeFrom?, id?, inReplyTo?, bodyKind?, claims, jobs, announced, next, handoffs, threads, awaiting, blocked, wakes, inbox, mailbox, board, channels, seats?}` or `{status:'invalid',
reason}` for a
ref outside the printable-label rule, a `job` outside the same rule
(`invalid-job`), a `contains` outside the shared bounded free-text
rule every bus `--contains` read applies (`invalid-contains`), a
`since` or `before` that is not a safe non-negative epoch-ms integer
(`invalid-since`/`invalid-before`), a `priority` outside the P0..P3 band
(`invalid-priority`), a `channel` outside the strict channel-name
grammar every bus `--channel` read validates (`invalid-channel`), a
`from`/`excludeFrom` outside the same printable-label bound every bus
sender filter shares (`invalid-from`/`invalid-exclude-from`), or an
`id`/`inReplyTo`/`bodyKind` outside the same printable-label bound every bus
`--id`/`--in-reply-to`/`--body-kind` read validates (`invalid-id`/`invalid-in-reply-to`/`invalid-body-kind`).
`job`, `contains`, `since`/`before` (as ISO), `priority`, `channel`, `from`, `excludeFrom`, `id`, `inReplyTo` and `bodyKind` echo the applied
filters and are absent on an
unfiltered read. `agent` echoes `ref`, resolved
`handle`/`identity` (null when unregistered) and the `registry` state.
`claims` reuses
`listBusClaims({owner})` — identity-aware owner matching with exact-label
fallback — as `{status:'ok', source, claims, owner}` or `{status:'unavailable'}`;
each claim row is a `BusClaimsListClaim` that gains `jobs` (the announced jobs
its keys block, `{id, owner, status, title, detail?}`) only when the feed read is `ok`,
absent otherwise. A claim row is a `BusWorkMineClaim`: on `origin:'message'`
claims (`queue:<envelope-id>` keys) it also carries `message`, a
`BusWorkMineClaimMessage` naming the retained envelope the lease covers —
resolved across all message claims in one bounded inbox walk plus one
`inspectBusWorkClaims` journal read, never one scan per claim. `resolved`
carries `id`, `cursor`, ISO `ts`/`expiresAt`, `priority`, raw `to`/`from`
labels, resolved `fromAgent` (null unregistered), `bodyKind` (the
`busBodyKind` discriminator — the body's own `kind`, else
`protocol.kind`, `type` or `schema`), the body's own `inReplyTo` citation verbatim
(absent when the body cites nothing through that field — never the
`replyTo` alias), a scrubbed clipped `summary`, optional live
`job` feed citation on `jobId` bodies and `pinned` — `true` when a journal
row's `(id, cursor, receivedAt)` triple matches the live receipt, `false`
when the journal reads clean but holds no row for the claim (bare-id
fallback to the newest same-id receipt), `null` when the journal is
unreadable. `resolved` also carries `jobIds` — every job id the leased
body names under the `busBodyJobMatch` citation rule (the feed `jobId`,
a `worker-handoff` `taskId`, the `job:<id>` thread label), sorted and
deduplicated, absent when the body names none — the set a `--job`
claims filter matches against. A journal-pinned triple no live receipt reproduces reports
`{status:'not-found'}` — a same-id replacement is a different generation —
and an inbox read that is not `ok` reports `{status:'unavailable'|
'retryable'|'invalid'}` while the claim row itself still lists. Every other
origin covers a scope key, not mail, and carries no `message`. `jobs` reports the open feed jobs
(`BUS_FEED_OPEN_STATUSES`, at least one claim key, newest 50 of `open`) as
`BusWorkMineJob` (`BusWorkFeedJob` — so it carries the feed's `postId`/`statusId`
envelope citations and any `work.result` report — plus `addressed`, `announced`, `freeKeys`,
`heldKeys`, `claimable`, `holders`): `addressed` marks announcements that are pending
work for the agent under the same rule the feed `--to` filter and the
next/handoffs sections share — `busWorkFeedPendingToMatcher`: any label of
the resolved identity or a `group:<channel>:<topic>` address of a registry
channel it belongs to, minus the agent's own channel posts (an unresolvable
ref or unreadable registry keeps exact-label matching, so unknown identity
state never widens it); `announced` marks an `owner` label resolving to the
agent's identity (the agent posted the job and owns its status reports)
through the identity-label contract `busWorkFeedOwnerMatcher` applies;
`holds` is `complete`/`truncated`/`unknown` from the feed's
claims join, and `claimable` is `true` only on a provably free key, `false`
only when every declared key is provably held, `null` when coverage is
`truncated` or `unknown` — `busWorkMineJobAnnotation(job, held, coverage,
addressed, announced?, holds?)` is the exported pure rule. `holders` lists
the shown live holds on the job's declared keys — each `{claimKey, owner,
leaseUntil, origin}` (`BusWorkMineJobHold`) projected from the feed's
claims join, so the digest names who blocks each key and until when without
a `claim list --jobs` read; it is `null` when hold coverage is `unknown`
(the coordination table could not be read) and the shown lower bound under
`truncated`, and it never carries fencing tokens or lease source ids. A
non-ok feed collapses the section to
its own status (`refused` keeps `reason`/`receipts` and the blamed `receipt`
when the projection named one). `announced` is the
outbound side of the same feed read: every job whose `owner` label resolves
to the agent under the jobs section's owner matcher that has not reached
`done` or `terminated`, newest update first, capped at the first 50 shown
with `matched` the true total and `truncated` definitive — `failed` stays
listed because only the announcer may move a job and a failed one can still
be rescheduled or terminated. Each item is a `BusWorkMineAnnouncedJob` —
`BusWorkFeedJob` plus the same per-key hold coverage the jobs section
computes, so it carries the feed's `postId`/`statusId` envelope citations
and any `work.result` report, plus `held`/`heldKeys`/`freeKeys`/`holders`:
`held` is `true` when a declared key has a
shown live hold, `false` when complete coverage proves none is held or the
job declares no keys, `null` when coverage cannot prove either way (a
`running`/`idle` announcement with `held:false` has no live claim on its
declared scope — the announcer is the only one who can move it); `holders`
is the same shown-hold list the jobs section reports under the same
unknown/truncated honesty;
`busWorkMineAnnouncedAnnotation(job, held, coverage, holds?)` is the exported pure
rule over the same coverage/`heldByJob`/`holdsByJob` index the jobs section uses. A job still
open with claim keys appears in both `jobs` (the claimable view) and
`announced` (the ownership view). A non-ok feed reports the section's own
`refused`/`unavailable`/`retryable`/`invalid` state, never an empty list.
`next` lists the
claimable work envelopes addressed to the agent — every live receipt whose
`isClaimableWork` body (`kind:'work'` or a protocol-v1 `task`) and whose `to`/`from`
pair satisfies the shared `agentPendingAddressMatcher` rule `bus next` claims
by: the literal ref or any label of the resolved identity through the same
matching the feed `--to` filter uses, or a `group:<channel>:<topic>` address
of a registry channel the resolved identity belongs to (the same membership
rule the inbox and wake reads apply, minus the agent's own channel posts; an
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
and `truncated` definitive. A handoff the addressee already answered is not
pending and does not list: the walk also collects every live envelope's
`inReplyTo`/`replyTo` citations (`busReplyCitations`), and a citation routed
recipient -> sender — the direction the handoff verbs publish, resolved
through the identity registry so the reply's `to` may name the assigner
under any of its labels and its `from` may name the addressee under any of
its labels or, for a `group:<channel>:<topic>` address, a member of that
channel (`handoffAnswerScope`/`workerHandoffAnswered` in
`src/core/fleet/handoff-body.ts`; an unreadable registry keeps
literal-label matching, never widening) — drops
the assignment, the same durable evidence the
conversation projection credits when it marks the thread answered; a
citation routed any other way, or one that has expired out of the retained
window, leaves the handoff pending. Each `BusWorkMineHandoff` carries `cursor`,
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
`threads` lists the conversation threads whose latest message still wants
the agent's answer — the same `state:'waiting'` threads
`agents conversations --waiting-only` computes from the one shared
conversations projection, narrowed to waits the agent owes: `waiting.on`
names the agent under any of its identity labels or a
`group:<channel>:<topic>` address of a registry channel it belongs to (the
same membership rule the other sections apply, minus threads whose waiting
message the agent itself sent — you cannot owe yourself a reply), with the
literal-label fallback when no identity resolves. Each
`BusWorkMineThread` carries the conversation key `id`, the waiting
message's envelope `id` as `messageId` (the handle `agents bus show`
takes), `kind` (`'ask'`|`'handoff'`), `waitingOn`, `waitingMs`, `lastAt`,
`messageCount`, the sender's projection `from`/`fromAgent` and the
scrubbed `subject`; the first 20 show longest-waiting first with `matched`
the true total and `truncated` definitive. The section reports
`{status:'ok', source, matched, items, truncated, skipped}` — `skipped`
keeps the damaged-row count — or `{status:'unavailable'}` when the bus
store cannot be read; a missing store is a verified-empty `ok`.
`awaiting` is the outbound mirror of `threads` over the same shared
conversations read: every `state:'waiting'` thread whose latest message
the agent itself sent (`isSelf` on the last message's `from`) and whose
`waiting.on` does not resolve back to the agent — the agent's own asks
and handoffs nobody has answered yet, so "is my question still
outstanding?" needs no second `agents conversations` read. The two
sections are mutually exclusive on every thread. Each
`BusWorkMineAwaitingItem` carries the same fields as `BusWorkMineThread`
— conversation `id`, waiting `messageId`, `kind`, `waitingOn`,
`waitingMs`, `lastAt`, `messageCount`, sender `from`/`fromAgent`,
scrubbed `subject` — plus `waitingOnAgent`, the resolved handle of the
party owing the reply (null for a topic or `group:` address, an
unregistered label, or an unreadable registry). Same 20-item cap,
longest-waiting order, `matched`/`truncated`/`skipped` semantics and
`unavailable`-on-unreadable rule as `threads`.
`blocked` is the third view over the same shared conversations read — now
unfiltered, so all three sections narrow one projection at the frozen
instant: every `state:'blocked'` thread (a blocker or failed report nothing
has answered) the agent is a party to, where participation is any
participant name the section's denotes rule matches — the agent's own
labels, a name resolving to its identity, or a `group:<channel>:<topic>`
address of a registry channel it belongs to. A block the agent reported
itself still lists: the thread stays pending until a newer message moves it
out of the state. Each `BusWorkMineBlockedItem` carries the conversation
`id`, the latest message's envelope `id` as `messageId`, its `kind`, the
sender's `from`/`fromAgent`, the recipient `to`, `lastAt`, `blockedMs`
(ms the thread has stood blocked at the frozen instant), `messageCount` and
the scrubbed `subject`; the first 20 show longest-standing first with
`matched` the true total and `truncated` definitive, same
`matched`/`truncated`/`skipped`/`unavailable` semantics as `threads`.
`wakes` reuses
`readAgentWakes` capped at the newest 20 with `matched` the count of every
hint the bounded queue tail matched for the agent before its row cap —
a lower bound, never a proven total, when `truncated` marks queue-tail or
cap cuts beyond the shown slice — carrying the same `scope`
(`'identity'`/`'label'`) the page reports — claim-holder `wh-…` rows carrying the
same `claimHolder` citation `readAgentWakes` resolves — and
`unknown-agent`/`unavailable` with `reason`. `inbox` reuses `readAgentInbox`
for the next page of mail addressed to the agent — same matching, order and
owner-share receipt checks as `agents bus inbox` — as `{status:'ok', agent,
messages, nextCursor, matched, truncated}`: `matched` is the true pending
total — every row the same filters accept across the whole retained store,
counted by a full scan the read performs on request (`page.matched`), while
`messages` still caps at the page `limit` — each `BusWorkMineInboxMessage` carries
`cursor`, envelope `id`, `ts`, `priority`, `kind`, `channel`, raw `from`,
resolved `fromAgent` (null when unregistered), a `summary` through
`busBodySummary`/`busBodyFallbackSummary`, scrubbed, single-lined and clipped
to 200 characters for both JSON and human output, and — only on claimable
work and worker-handoff mail — the same optional `held`/`holder` evidence
`agents bus inbox` reports (`held` tri-state, `null` when a hold store cannot
be read, never proven free; absent on other mail kinds), plus — only on
mail whose body declares a `jobId` (`work.post`, `work.status`,
`work.result` or `wake`) — the same optional `job`
(`BusEnvelopeLookupJob`) live-feed citation `agents bus inbox` resolves, so
the digest's mail rows answer where each announced job stands without a
`show` per message. The read asks
for one row past the 20-message cap so `truncated` is definitive — a full
window proves mail remains beyond `nextCursor`, a short one proves the scan
reached the store's end — and on overflow the newest scanned row is the one
dropped, so `nextCursor` resumes strictly before it. A non-ok inbox read
reports `unknown-agent`/`unavailable`/`retryable`/`invalid` with `reason`.
`mailbox` is the digest's window into the legacy `phm bus` mailbox store
(`$ASHLR_HOME/bus-mailbox`, the records `phm bus inbox --to <label>` reads and
`phm bus ack` clears) that the unified bus store never carried: every pending
(unacked, unexpired) message addressed to any of the agent's labels, merged in
the mailbox's own priority/acceptance/id drain order, capped at the first 20
shown with `matched` the true total and `truncated` definitive. The store's
`inbox(to, limit?, match?)` takes the same optional `match` predicate
`pendingFor` does — applied to the pending set before `limit` and `hasMore`
count it — and `phm bus inbox` composes the shared bus read filters
(`--from`/`--exclude-from` sender matching, `--priority`, `--job`,
`--channel`, the `[since, before)` acceptance-time window, `--contains`,
`--in-reply-to`, `--thread`, `--id` and `--body-kind`) into that one
predicate, so the legacy mailbox read answers the same filter grammar every
other bus read shares. Labels are the
resolved identity's `agentLabels` set, or the literal ref alone when no
identity resolves — an unreadable registry or unregistered ref never widens
the match. Each `BusWorkMineMailboxMessage` carries the envelope `id` (the
handle `phm bus ack` takes), the `to` label to pass verbatim as `--to`, raw
`from`, `priority`, `ts`, `expiresAt` and the same scrubbed single-line
`summary` the inbox section composes. The store home is `mailboxHome`, else
`dirname(root)` when `root` is set — the fleet root's parent — else
`ashlrHome()`; an absent store is a verified-empty `ok` (`matched: 0` is
proven, not fabricated) and an unreadable one reports
`{status:'unavailable', reason}`.
`board` is the digest's window into the shared task board
(`src/core/fleet/bus-board.ts`, the store `phm bus board pending` reads)
that the unified bus never carried: `BusBoard.pendingFor(labels, now, jobId?, contains?, sinceMs?, beforeMs?, sender?)` runs
the board's own locked snapshot plus one shared-queue claim-index read under
the union of every label the agent answers to, so an agent on the board no
longer needs a separate `--peer` read per label. Its fleet-wide form,
`BusBoard.pendingAll(now?, jobId?, contains?, sinceMs?, beforeMs?, sender?)`, takes the same
optional filters over every thread member as the label set — the digest
`phm comms inbox`'s board source and `fleet_bus_board` project through the
shared `readBusBoardPending` read, which reports `missing` for a
verified-empty board and `unavailable` for an unreadable one, takes
`from`/`excludeFrom` agent refs that `busBoardPendingSender` resolves
through the identity registry under the board's fleet root into the
`sender` slice — the same `agentRefAddressMatcher` rule every bus
`--from`/`--exclude-from` read applies, exact-label fallback on an
unresolvable ref or unreadable registry — and `phm bus
board pending --all` serves the same `pendingAll` digest directly. The
single-peer form `phm bus board pending` serves,
`BusBoard.pending(actor, now?, jobId?, contains?, sinceMs?, beforeMs?, sender?)`, takes the
same optional filters under the identical `pendingDigest` rules while
keeping its `peer` display shape. `peers` names the queried
labels the board actually knows — each a member of at least one thread,
sorted — so an agent that never joined reads verified-empty rather than
mistaking "not a peer" for "nothing pending"; `threads` keeps the board's
joined-thread rollups (member list, pending-delivery count, per-hold task
counts) and `deliveries`/`tasks` keep the board's 50-item caps with `matched`
the true totals and `truncated` definitive. Each
`BusWorkMineBoardDelivery` carries the delivery `id`+`threadId` pair
`phm bus thread ack` takes, raw `sender`/`recipient` labels, `createdAt`
and the post text scrubbed, single-lined and clipped; each
`BusWorkMineBoardTask` carries `id`, `threadId`, the fleet `itemId`, the
scrubbed single-line `title`, the board's `claimed` flag, the observed
queue `hold` (`open`/`held`/`ambiguous`/`unknown` — `unknown` for every
task, with section `claims:'unreadable'`, when the queue cannot be read,
never `open` by default) and the live `owner` peer label plus lease expiry
when `held` — never capability material. Labels are the resolved identity's
`agentLabels` set, or the literal ref alone when no identity resolves —
the same narrowing the mailbox section applies. Board paths derive exactly
like the board CLI — `<dirname(root)>/bus` and `<root>/bus-queue`, or the
configured `fleet.sharedQueue` filesystem `path` and `path/bus` under
`trustedCoherentStorage`, with `board.root`/`board.queueRoot`/`board.leaseMs`/
`board.config` as absolute-path and config overrides (`board.config`
defaults to `loadConfigReadOnlyStrict`, a malformed shared-queue config or a
relative override reports `unavailable`). A board never used — no
`state.json` — is a verified-empty `ok` and the read never creates its
directory or lock file; an unreadable board, a disabled event bus or a read
fault reports `{status:'unavailable', reason:'board-unreadable'}`. Under
`sinceMs` the digest keeps only deliveries whose `createdAt` reaches the
cutoff — tasks, which the board records without any timestamp, never
match — and a thread rollup lists only while it still holds a surviving
delivery, the rollup itself carrying no time. `beforeMs` is the exclusive
upper bound on the same `createdAt` field every bus read's `--before`
shares: a delivery matches only when its parsed time is strictly below the
cutoff, so `sinceMs`/`beforeMs` read one `[since, before)` window — the
lower bound inclusive, the upper exclusive, an unparseable `createdAt`
satisfying neither — while tasks stay unmatchable under either bound and
the rollup rule is unchanged. Board
content stays `trust:'untrusted'` shared data: it coordinates attention,
never grants execution authority.
`channels` is the digest's window into the registry channels the agent
belongs to — the routing context behind every `group:<channel>:<topic>`
item the next, handoffs, threads, inbox and board sections match, so
channel-addressed work no longer needs a separate `agents bus channel
list` read to learn which rooms the agent sits in. It reuses the same
`readAgentRegistry` load every other section resolves addressing through
— no second store walk — as `{status:'ok', source, channels}` or
`{status:'unavailable', reason}`. `source` follows the registry read:
`missing` is a verified-empty membership, `available` lists real
memberships name-sorted; an unreadable registry reports `unavailable`,
never an empty list passed off as fact. Each `BusWorkMineChannel` carries
the channel `name` and its registered `memberCount` — the digest carries
no member list (`channel list` does); membership says who may post,
never presence, attention or authority. An agent ref that resolves to no
identity has no handle and provably belongs to no channel, so `channels`
is then empty, not unknown.
`seats` is the digest's window into bot-seat handoff work, present only on
the async `readBusWorkMineWithSeats(agent, options?)` read the CLI serves
(`src/core/agents/bus-work-mine-seats.ts`) — the synchronous
`readBusWorkMine` leaves it absent rather than reporting a section it never
read. It reuses the same `planSeatHandoffs` projection `phm bots handoffs`
and `phm comms inbox --source seats` serve, so the surfaces cannot disagree:
every roster seat the agent denotes — the literal seat id or its
`participantId` under any label of the resolved identity, exact-label
fallback when the ref resolves to no identity or the registry is
unreadable — that is eligible and still carries pending (not yet
journaled) handoff records, the first 20 shown with `matched` the true
total and `truncated` definitive. A `BusWorkMineSeat` carries `seatId` (the
`--seat` handle `phm bots handoff` takes), `participantId`, the projected
lifecycle `state` and `handoffs` — each a `BusWorkMineSeatHandoff` with the
deterministic `handoffId` the apply journal dedupes on, the held `work`
(`node-job` queue id or `bus-claim` claim key), `branch` and `pr`. Seat
handoffs are agent work, never owner-blocking, and the read never releases
or applies. `options.seats` (`SeatOptions`) overrides the plan read's home,
runs, clock, fleet root, quota reader and node store; `fleetRoot`, `runs`
and `now` default to the digest's `root`, `runsRoot` and frozen clock so
seat work joins the same coordination table, identity registry and quota
evidence. A throwing plan read reports `{status:'unavailable',
reason:'seat-handoff-plan-unreadable'}`, never an empty plan passed off as
fact; `busWorkMineSeatsFromPlan(plan, denotes, job?, contains?)` is the exported pure
shaping rule. The section takes no `since`/`before`: a pending handoff
record's `createdAt` stamps the plan read instant, not the held work's
age, so no per-record recency exists to filter on — every listed record
is current
evidence and the section stays whole like `channels`. `formatBusWorkMine(result)`
renders the shared human lines — titles, the declared dispatch spec and key
lists scrubbed, single-lined and display-clipped (the same
`busWorkJobDispatch` tag the feed job line prints); JSON keeps full values.
Exit 0 on a completed read, 2 on an invalid agent, job, contains, since,
before, priority or channel.

`options.job` narrows the whole digest to one job id under the same
`busBodyJobMatch` citation rule the inbox/channel `job` filters apply —
a feed `jobId` body, a `worker-handoff` `taskId`, or the `job:<id>`
thread label — joined with the feed-id and board `itemId` identity
citations each section already makes: `jobs`/`announced` match feed job
ids, `claims` keep a row only when it provably relates — declared-key
overlap with an announced job (`claim.jobs`, present only on an ok feed)
or a resolved leased message whose body names the job (`message.jobIds`)
— `next`/`handoffs` filter the shared pending-work walk by
`busBodyJobMatch` (claimable `kind:'work'`/protocol-`task` receipts name
no job citation, so `next` comes back empty under `--job` while
worker-handoffs keep their `taskId` hits),
`threads`/`awaiting`/`blocked` pass `job` into the one shared
conversations read, `wakes`/`inbox` pass it to `readAgentWakes`/
`readAgentInbox`, `mailbox` applies the same body predicate through
`BusMailbox.pendingFor`'s `match` argument (applied before `matched` and
`limit` count, so the filtered total is the filtered total), and `board`
passes it to `BusBoard.pendingFor`, which scopes the digest to threads
carrying a task whose `itemId` equals the job id — the fleet item and
bus job share the id namespace — with that thread's deliveries and
rollup riding along while `tasks` list only on the per-item citation.
The `seats` section keeps only `node-job` handoff records whose ref is
the job id — a `bus-claim` ref is a coordination claim key, not a job
citation — and seats left with no records drop out of `matched`.
Every count stays the filtered total — `matched`/`open`/`truncated` all
measure the filtered sets — and a row whose job relation cannot be
proven (a scope-key claim, an unreadable feed, an unresolvable message)
stays out of the match rather than padding it.

`options.contains` narrows the whole digest to the rows whose displayed
descriptive text carries the needle — the same case-insensitive
substring rule every other bus `--contains` read applies, normalized
once through `busReadContains` and matched over scrubbed one-line
display text, never raw bodies, ids, claim keys as keys, statuses or
routing labels: `jobs`/`announced` match `busWorkFeedJobSearchText` (the
feed's own title/detail/dispatch haystack), `claims` keep a row only
when its displayed evidence carries the needle — a blocked announced
job's title or newest status detail (`claim.jobs`) or a resolved leased
message's summary, with a claim whose evidence cannot be read naming no
provable text — `next`/`handoffs` apply `busReadContainsMatch` to the
envelope body inside the shared pending-work walk, `threads`/`awaiting`/
`blocked` pass `contains` into the one shared conversations read (member
-message subjects, the same query `agents conversations --contains`
serves), `wakes` pass it to `readAgentWakes`' `filter.contains`,
`inbox` passes it to `readAgentInbox`, `mailbox` ANDs
`busReadContainsMatch` into `BusMailbox.pendingFor`'s `match` predicate,
`board` passes it to `BusBoard.pendingFor` (deliveries match
`busBoardDeliveryText`, tasks and thread titles match theirs, and a
thread rollup survives on a matching title or a surviving member item —
with per-thread pending counts measuring matching items only and `peers`
still reporting board membership independent of the text filter), and
`seats` keeps only handoff records whose held-work `ref`/`branch`/`pr`
carries the needle — the only descriptive fields a seat record holds.
`channels` is registry context, not pending work, and stays unfiltered
like it does under `job`. Every count stays the filtered total, and a
row whose text cannot be proven never matches.

`options.since` narrows the whole digest to pending items whose recorded
time reaches the epoch-ms cutoff — the shared `--since` grammar and the
inclusive `>=` match every bus read applies (the wakes read's own
strictly-after boundary included, since the section delegates to it), so
a polling agent reads the delta since
its last check instead of re-reading the whole pending set; each section
keys on the timestamp its own store keeps: `claims` match the lease's
recorded `started` ISO (a null start is unknown and never matches),
`jobs`/`announced` match the feed job's `updatedAt`, `next`/`handoffs`
match the envelope `receivedAt` inside the shared pending-work walk (a
since-filtered handoff still sees its answer in the reply-citation
scan), `threads`/`awaiting`/`blocked` pass `since` into the one shared
conversations read (thread `lastAt`, the same query
`agents conversations --since` serves), `wakes` pass it as `sinceAt` to
`readAgentWakes` — the same boundary `agents bus wakes --since` serves —
`inbox` passes it to `readAgentInbox`, `mailbox` ANDs
`acceptedAt >= since` into `BusMailbox.pendingFor`'s `match` predicate,
`board` passes it to `BusBoard.pendingFor` (deliveries match `createdAt`,
tasks never match for want of a recorded time, and a thread rollup lists
only while a surviving delivery remains), and `seats` stays unfiltered —
a pending handoff record's `createdAt` stamps the plan read instant, not
the held work's age, so no per-record recency exists to filter on.
`channels` is registry
context, not pending work, and stays unfiltered like it does under
`job`/`contains`. A pending item older than the cutoff is still pending
but is not new; every count stays the filtered total, and an item whose
store keeps no timestamp never matches — the same "unknown stays out"
rule the unified inbox's `--since` applies.

`options.before` narrows the whole digest to pending items whose recorded
time is strictly below the epoch-ms cutoff — the exclusive upper bound
every bus read's `--before` shares on the same grammar — composing with
`options.since` into one `[since, before)` window (lower inclusive, upper
exclusive, an item stamped exactly at either bound excluded from the
excluded side) so "what was pending before time T" and "what changed in
the window" are one filtered digest. Each section keys on the same
per-store timestamp `since` uses: `claims` match the lease's recorded
`started` ISO strictly below the cutoff (a null start is unknown and
never matches), `jobs`/`announced` match the feed job's `updatedAt`,
`next`/`handoffs` match the envelope `receivedAt` inside the shared
pending-work walk (a before-filtered handoff still sees its answer in
the reply-citation scan), `threads`/`awaiting`/`blocked` pass `before`
into the one shared conversations read (thread `lastAt`, the same query
`agents conversations --before` serves), `mailbox` ANDs
`acceptedAt < before` into `BusMailbox.pendingFor`'s `match` predicate,
and `board` passes it to `BusBoard.pendingFor` (deliveries match
`createdAt`, tasks never match for want of a recorded time). `inbox`
and `wakes` delegate both bounds to their shared reads —
`readAgentInbox`'s `before` on `receivedAt` and `readAgentWakes`'s
`filter.before` on the hint's queue time — each the same exclusive
upper bound every other bus read's `--before` applies, so the cutoff
reaches them like every other section; `channels` and `seats` carry no
per-item historical timestamp at all and stay unfiltered. Every count
stays the filtered total, and an item whose store keeps no timestamp or
is stamped at or after the cutoff never matches — the same "unknown
stays out" rule the other time bound applies.

`options.priority` narrows the whole digest to pending items stamped
with that exact P0..P3 band — the same match every bus read's
`--priority` applies — across the sections whose items carry a wire
band: `next`/`handoffs` keep envelopes of that priority inside the
shared pending-work walk, `inbox` passes it to `readAgentInbox`,
`mailbox` ANDs `envelope.priority === priority` into
`BusMailbox.pendingFor`'s `match` predicate, `wakes` pass it to
`readAgentWakes`' `filter.priority` (the resolved referent's band —
`unresolved`/`unknown` referents never match), and `claims` keep only
message claims whose resolved leased envelope reports that band
(`claim.message.status === 'resolved'` and `message.priority` equal) —
a claim with no resolved message, a scope-key claim or an
unresolvable/unreadable lease names no provable band and never lists,
the same "unknown stays out" rule the `job` filter applies.
`jobs`/`announced` (feed jobs carry no wire band in the projection),
`threads`/`awaiting`/`blocked` (a thread mixes bands), `board` (board
rows carry no per-item band), `channels` and `seats` stay unfiltered —
registry context and band-less projections, like `channels` under every
filter. Every count stays the filtered total, and a row whose band
cannot be proven never matches.

`options.channel` narrows the whole digest to pending items provably
addressed to `group:<name>:*` of one bus channel — the same room prefix
every bus read's `--channel` matches, validated by the strict
channel-name grammar and matched as a raw `to` prefix that needs no
registry and never widens on unknown state: `jobs`/`announced` keep
announcements whose `to` carries the prefix (the feed `--channel`
rule), `next`/`handoffs` keep envelopes whose `to` carries it inside
the shared pending-work walk (a channel-filtered handoff still sees
its answer in the reply-citation scan), `claims` keep only message
claims whose resolved leased envelope's `to` carries it — a claim
with no resolved message, a scope-key claim or an unresolvable/
unreadable lease names no provable room and never lists, the same
"unknown stays out" rule `priority` applies — `threads`/`awaiting`/
`blocked` keep threads whose latest message — the wait's own
recipient for waiting threads, the block report's recipient for
blocked ones — is addressed to the room, `wakes` pass `channel` to
`readAgentWakes`' `filter.channel` (the hint's own `to` prefix),
`inbox` passes it to `readAgentInbox` (the member-channel rule — a
room the agent does not belong to simply has no mail to show), and
`mailbox` ANDs the `to` prefix into `BusMailbox.pendingFor`'s `match`
predicate. `board`, `channels` and `seats` carry no per-item room in
their projections and stay unfiltered, like they do under `priority`.
Every count stays the filtered total, and a row whose room cannot be
proven never matches.

`options.from` narrows the whole digest to pending items provably sent
by the named agent — the same sender rule every bus `--from` read
applies, validated by the printable-label bound and matched through
`agentRefAddressMatcher` identity-label matching (an unresolvable ref
or unreadable registry keeps exact-label matching, never widened):
`jobs`/`announced` keep announcements whose `owner` resolves to the
ref — the announcer is the sender of a `work.post`, matched by the
same `busWorkFeedOwnerMatcher` the feed `--owner` filter applies —
`next`/`handoffs` keep envelopes whose `from` the matcher accepts
inside the shared pending-work walk, `mailbox` ANDs the `from` match
into `BusMailbox.pendingFor`'s `match` predicate on the envelope's own
`from`, `claims` keep only message claims whose resolved leased
envelope's `from` matches — a claim with no resolved message, a
scope-key claim or an unresolvable/unreadable lease names no provable
sender and never lists, the same "unknown stays out" rule `priority`
applies — `threads`/`awaiting`/`blocked` pass `from` into the shared
`readAgentConversations` query's own member-message sender filter so a
thread survives on any member message the matcher accepts, `wakes`
passes it to `readAgentWakes`' `filter.from` and `inbox` to
`readAgentInbox`'s `from`, and `board` passes a `BusBoardSenderFilter`
to `BusBoard.pendingFor`/`pendingAll`'s new trailing `sender` argument
— deliveries keep only posts whose `sender` peer label the matcher
accepts while tasks, which record no author, never match under `from`
and thread rollups keep only while a surviving delivery or task
remains. `seats` handoff records and `channels` carry no per-record
sender in their projections and stay unfiltered, like they do under
`priority`. Every count stays the filtered total, the result echoes
`from`, and a row whose sender cannot be proven never matches.
`options.excludeFrom` inverts the same match — a section keeps an item
unless its sender evidence resolves to the excluded ref, so a sender
that cannot be proven excluded is never dropped: `jobs`/`announced`
keep announcements whose `owner` does not resolve to the ref,
`next`/`handoffs`/`mailbox` keep envelopes whose `from` the matcher
does not accept for the excluded ref, `claims` keep only resolved
message claims whose leased envelope's `from` does not match (the same
"unknown stays out" rule — a claim with no provable sender never
lists), the thread sections pass `excludeFrom` into the shared
conversations read, `wakes`/`inbox` pass it to their own reads, and
`board` deliveries drop posts whose `sender` resolves to the excluded
ref while board tasks stay listed — nothing proves a task came from
the excluded sender. The two compose in the same include-then-exclude
order every bus read applies — a sender both included and excluded
matches nothing; every count stays the filtered total, and the result
echoes `excludeFrom`.

`options.bodyKind` narrows the whole digest to pending items whose body
carries that exact kind discriminator — the same `busBodyKind` match
every bus read's `--body-kind` applies (the body's own `kind`, else
`protocol.kind`, `type` or `schema`; exact and case-sensitive, a body
carrying none never matching), validated by the same printable-label
bound: `next`/`handoffs`/`mailbox` keep envelopes whose body reports
that kind inside the shared pending-work walk and `BusMailbox.pendingFor`'s
`match` predicate — claimable `work`/`task` receipts answer under
`work`/`task`, `worker-handoff` assignments under `worker-handoff`, and
kindless legacy mail never matches — `claims` keep only message claims
whose resolved leased envelope reports that kind (the resolved message's
own `bodyKind`, the same `busBodyKind` evidence its display field
carries; a claim with no resolved message, a scope-key claim or an
unresolvable/unreadable lease names no provable kind and never lists,
the same "unknown stays out" rule `priority` applies) — `inbox` passes
it to `readAgentInbox`'s `bodyKind`, `wakes` to `readAgentWakes`'
`filter.bodyKind` (the resolved referent's kind), and
`threads`/`awaiting`/`blocked` pass it into the one shared
`readAgentConversations` query's `bodyKind` (a thread survives on any
member message whose body carries it). `jobs`/`announced` keep the feed
jobs citing at least one retained receipt of that kind — the feed fixes
each citation slot's kind, so `work.post` keeps every job (each cites
its announcement), `work.status` keeps jobs a status receipt has moved
(`statusId` non-null), `work.result` keeps jobs a result receipt cites,
and any other kind is an honest empty match. `board`, `channels` and
`seats` carry no per-item retained body in their projections — board
post bodies are `{threadId, text}` records and seat handoff records keep
no per-record body — and stay unfiltered, like they do under `priority`.
Every count stays the filtered total, the result echoes `bodyKind`, and
a kind nothing on the bus carries is an honest empty match, never an
error and never a widened one.

### Unified agent bus (RQ-BUS-UNIFY-1)

`src/core/agents/bus-identity.ts`: `stableAgentId(handle): string` (`agt_` + 20 hex),
`agentAddress(handle)`, `resolveAgent(registry, ref)`, `agentLabels(identity)`,
`agentIdentityKeys(options?)`, `agentAddressMatcher(identityOf, label)`,
`agentRefAddressMatcher(ref, registry, identityOf?)` (the read-filter
predicate every caller-supplied agent ref shares — `inbox`/`channel read`
`from`/`excludeFrom`, `comms bus read|watch` `--to`/`--from`/`--exclude-from`,
`fleet bus-follow` `--from`/`--exclude-from`, `fleet_bus_inbox`'s `to`/`from`/
`excludeFrom`, the classified-messages reads' `to` (`phm messages`,
`phm agents messages`, `phm bus recent`, `phm fleet map messages`,
`phm fleet messages`, their API params and the `fleet_agent_messages` MCP
`to`), the work-feed `--owner` announcer match and request/handoff
correlation refs: the literal ref or any label of the identity `resolveAgent`
proves it to be — the ref itself never case-folds, so a spelling like `Devin`
naming no registered label keeps exact-label matching rather than inheriting
handle `devin`'s label set, while envelope-side labels still fold exact-first
then lowercase through `identityOf`, defaulting to `identityKeysFor(registry)`;
an unreadable registry or unresolvable ref matches the literal ref only, so
unknown identity state never widens a filter),
`agentPendingAddressMatcher(ref, registry)` (the shared addressed-to-agent
predicate the `bus next` claim scan and the `work mine` next/handoffs
sections apply: the literal ref or any label of its resolved identity, or a
`group:<channel>:<topic>` address of a registry channel the identity belongs
to — minus channel posts the identity sent itself; an unreadable registry
passed as undefined or a ref resolving to no identity contributes no channels
and no labels beyond the literal ref, so matching never widens on unknown
state; the predicate takes the envelope's `to` and `from` labels),
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
carry `claimHoldersWoken`; the three conversational sends accept `replyTo`,
stamped as the body's `inReplyTo` citation after the same printable-label
check `thread` gets, and `kind` — `note` or `context`, the v2 conversational
body kind `postLabelMessage` already exposed, now shared by all three so a
DM or channel post can carry reference material too), `readAgentInbox(ref, {after, limit, thread?, from?, excludeFrom?, with?, priority?, kind?, job?, matched?, since?, before?, channel?, contains?, inReplyTo?, id?, bodyKind?}, options?)`
(`thread` keeps only `note`/`context` bodies carrying that v2 thread label,
`from` filters by sender through identity-label matching, an unresolvable ref
keeping exact-label matching, `excludeFrom` drops mail sent under every
registered spelling of one identity through the same matcher — an
unresolvable ref keeping exact-label matching — composing with `from` so a
sender both included and excluded matches nothing, `with` keeps only the
two-way exchange the addressed agent and one peer name — the peer's labels
on the sender side against the agent's own labels on the addressed side,
the same pairwise rule `phm messages --with` and `agents conversations
--with` apply, so channel posts and channel-addressed handoffs whose `to`
is a room address never match while every `dm`, `legacy` and
label-addressed `handoff` the peer sent remains — the ref resolving through
the same `agentRefAddressMatcher` with an unresolvable ref keeping
exact-label matching, `priority` keeps only envelopes stamped
with that exact P0..P3 band — the same match `comms bus read --priority`
applies, `kind` keeps only one delivery kind — `dm`, `channel`,
`handoff` or `legacy`, the same kind each inbox row reports, and `channel`
keeps only mail addressed to `group:<name>:*` of one registry channel the
agent belongs to — channel posts and channel-addressed handoffs alike,
matched on the delivery address rather than the reported kind, so it
composes with `kind` and a channel the agent is not a member of simply
has no mail to show; `job` keeps
only mail that names one job — a `work.post`/`work.status`/`work.result`/`wake`
body declaring that `jobId`, a `worker-handoff` assigning that fleet job id
through `taskId`, or a `note`/`context` body carrying the
`job:<id>` v2 thread label, the same bucket the messages and conversations
projections group under `job:<id>`; `since` keeps only mail received at
or after that epoch-ms cutoff — the same inclusive `receivedAt >= since`
match `phm messages --since` applies; `before` keeps only mail received
strictly before that epoch-ms cutoff — the exclusive upper bound every
bus read's `--before` applies — composing with `since` into one
`[since, before)` window on `receivedAt`; `contains` keeps only mail whose
scrubbed one-line summary — the same text the frame renders per row —
carries the needle as a case-insensitive substring, matching the rendered
summary rather than the raw body so a secret-shaped value stays
unfindable; `inReplyTo` keeps only mail whose object body cites that
envelope id through its own `inReplyTo` field — the shared
`busBodyInReplyToMatch` own-property exact match, never the `replyTo`
alias or a substring — so "which of my pending mail answers envelope X"
is one filtered read; `id` keeps only the row whose own wire id is
strictly equal to the value — the same exact-envelope match `comms bus
read|watch --id`, `fleet bus-follow --id` and `fleet_bus_inbox`'s `id`
apply, never a substring or a body citation — so "is envelope X still
pending for me" is one filtered read; `bodyKind` keeps only mail whose
body carries that discriminator — the same one `busBodySummary` switches
on, read verbatim by `busBodyKind`: the v2 `kind` (`note`, `context`,
`work.post`, `work.result`, `wake`, `worker-handoff`, …), else a
bus-transport v1 `protocol.kind`, else the `type`/`schema` a kindless
notice keys on — matched exactly and case-sensitively like every other
own-field filter, an unrecognized but printable value an honest empty
match and a body with no discriminator never matching, so "only the
`work.post` announcements" or "only `worker-handoff` assignments" is one
filtered read; `matched: true` scans the whole retained store
and returns `matched`, the count of every filter-matched row, while
`messages` still caps at `limit`; `group.presence` heartbeats are observations
with their own read and never appear as mail of any kind; claimable work and
worker-handoff items
additionally carry `held`/`holder` — the same hold evidence
`readBusEnvelopeById` reports, read once per page, `held` null when a hold
store cannot be read — and items whose body declares a `jobId`
(`work.post`, `work.status`, `work.result` or `wake`) additionally
carry `job` (`BusEnvelopeLookupJob`), the live feed state of the job
they cite resolved through the same feed read and job mapping
`readBusEnvelopeById` applies — one claims-joined feed read per page, only
when a returned message cites a jobId, so the citation answers where its
job stands (status, claim coverage, `job:null` on an orphaned citation, or
the feed's own refused/unavailable state) without a `show` per message),
`readAgentWakes(ref, sinceAt, options?, filter?)` (the ok page carries `scope` —
`'identity'` when the ref resolved through the registry and every spelling
that resolves to that identity — exact label first, then lowercase — plus
its member channels matched, `'label'` when the ref
resolved to no identity and only hints whose `to` is the queried label
verbatim matched, the same exact-label fallback the claim/next/owner
filters keep so bare coordination labels like claim-owner fan-out targets
stay readable; `agent` reports the resolved handle or the queried label —
plus `matched`,
every hint the bounded queue tail accepted for the agent before its row
cap, and `truncated`, true when the 256 KiB observation window or the cap
cut matches beyond the returned slice — `matched` is then a lower bound,
never a proven total; claim-holder `wh-…` hints additionally carry
`claimHolder` — the live terminal `work.status` receipt re-derived as the
hint's citation as `{statusId, jobId, status, detail?}`, `'unresolved'`
when no live receipt reproduces it, `'unknown'` when the bus store cannot
be read; every other `bus.send` hint additionally carries `message` — the
live envelope its id refers to, `resolved` with the receipt's summary,
priority, sender handle, channel and the same `held`/`job` evidence an
inbox row reports for claimable work or a `jobId` citation, `'unresolved'`
when the store was read and holds no live envelope with that id, `'unknown'`
when the store cannot be read; `filter.job` keeps only hints that provably
name one job — the same `busBodyJobMatch` rule the inbox/channel `job`
filters apply, decided on the resolved referent (a feed `jobId` citation,
a `worker-handoff` `taskId` or a `job:<id>` thread label) or on the
`jobId` a claim-holder hint's citing status carries, with `unresolved`/
`unknown` referents never matching, `matched` counting the proven matches
on the resolved page, an unreadable bus store answering `unavailable`
rather than an empty page, and a malformed job id answering `invalid`;
`filter.contains` keeps only hints whose resolved referent text — a
`bus.send` hint's live message summary or a claim-holder hint's citing
`work.status` detail, the same scrubbed one-line text the row reports —
carries the normalized needle as a case-insensitive substring, with
`unresolved`/`unknown` referents never matching (they name no provable
text), `matched` counting the proven matches on the resolved page, an
unreadable bus store answering `unavailable`, and a malformed contains
value answering `invalid`;
`filter.from` keeps only hints whose recorded `from` label matches one
agent through the same `agentRefAddressMatcher` identity-label rule
`readAgentInbox`'s `from` applies — a handle, `agent:<handle>`, stable id
or alias matching every label of that identity, an unresolvable ref
keeping exact-label matching — over the hint row's own `from` (the
triggering envelope's sender on a `bus.send` hint, the posting identity's
`agent:<handle>` on a claim-holder `wh-…` hint), with a malformed sender
filter answering `invalid`; `filter.excludeFrom` drops hints sent under
every registered spelling of one identity through the same matcher and
exact-label fallback, composing with `from` so a sender both included
and excluded matches nothing — the drop runs inside the queue-tail
match, so `matched` stays the count the whole filter set accepts, with a
malformed exclusion answering `invalid`; `filter.channel` keeps only
hints whose own `to` label sits under `group:<name>:*` — the same room
prefix `readAgentInbox`'s `channel` and `phm messages --channel` match,
grammar-validated by the shared channel-name rule and decided on the
hint's address alone, so it needs no referent resolution, composes with
the addressee scope (a per-agent read narrows to one room's hints for
that agent) and with every other filter, `matched` counting it inside
the queue-tail match, a name no hint addresses matching nothing rather
than erroring, and a malformed channel name answering `invalid`;
`filter.priority` keeps only
hints in one exact P0..P3 band — the same match every other bus read's
`--priority` applies — decided on the resolved referent's own band (the
live message a `bus.send` hint points at, or the citing `work.status`
receipt's band behind a claim-holder `wh-…` hint), with
`unresolved`/`unknown` referents never matching, `matched` counting the
proven matches on the resolved page, an unreadable bus store answering
`unavailable`, and a band outside P0..P3 answering `invalid`;
`filter.thread` keeps only hints whose resolved referent is a
`note`/`context` body carrying that v2 thread label — the same
`busBodyThread` own-field match the inbox and channel reads' `thread`
apply to the message a hint refers to — with claim-holder `wh-…` hints
never matching (a `work.status` receipt carries no thread label) and
`unresolved`/`unknown` referents never matching, `matched` counting the
proven matches on the resolved page, an unreadable bus store answering
`unavailable`, and a malformed label answering `invalid`;
`filter.inReplyTo` keeps only hints whose resolved referent body cites
that envelope id through its own `inReplyTo` field — the same
own-property exact match the inbox/channel `inReplyTo`, `phm messages
--in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet
bus-follow --in-reply-to` and `fleet_bus_inbox`'s `inReplyTo` apply,
never the `replyTo` alias or a substring — with claim-holder hints and
`unresolved`/`unknown` referents never matching under the same
unreadable-store/`matched` rules, and a malformed id answering
`invalid`;
`filter.bodyKind` keeps only hints whose resolved referent body carries
that exact kind discriminator — the same `busBodyKind` match the
inbox/channel `bodyKind` filters apply, decided on the resolved
referent (the v2 `kind` field, a `worker-handoff` assignment, a
bus-transport v1 `protocol.kind` or a `type`/`schema` notice
discriminator, exact and case-sensitive) — with a resolved claim-holder
`wh-…` hint matching only `work.status` (its citing receipt provably
carries that kind) and `unresolved`/`unknown` referents never matching,
`matched` counting the proven matches on the resolved page, an
unreadable bus store answering `unavailable`, and a malformed value
answering `invalid`;
`filter.result` keeps only hints whose resolved referent is a
`work.result` body reporting that one outcome — the same
`WORK_RESULT_OUTCOMES` codes and kind-scoped `busBodyResultOutcome`
own-field match the inbox/channel `result` filters apply, decided on
the resolved referent — with a claim-holder `wh-…` hint never matching
(its citing receipt is a `work.status` body, which provably reports no
result outcome) and `unresolved`/`unknown` referents and a `work.result`
carrying no outcome or one outside the vocabulary never matching,
`matched` counting the proven matches on the resolved page, an
unreadable bus store answering `unavailable`, and an outcome outside
`WORK_RESULT_OUTCOMES` answering `invalid`;
`filter.before` keeps only hints recorded strictly before that
epoch-ms cutoff — the exclusive upper bound every bus read's `--before`
applies on the hint's own queue time, composing with `sinceAt`'s
strictly-after boundary into one `(since, before)` window, decided on
the queue row's `at` alone so it counts inside the queue-tail match
like `channel`/`from`/`excludeFrom`, never fails closed on an
unreadable bus store, and answers `invalid` outside epoch-ms);
`filter.id` keeps only the hint whose own id is strictly equal to the
value — the triggering envelope's wire id on a `bus.send` hint, the
`wh-…` claim-holder id on those — the same exact-id match the inbox
and channel reads' `id` apply, decided on the queue row alone inside
the queue-tail match so it counts in `matched` and needs no referent
resolution, a malformed id answering `invalid`),
`readAllWakes(sinceAt, options?, filter?)` (the fleet-wide companion —
every hint the bounded queue tail holds with no addressee scope, so
hints queued under bare coordination or routing labels the
claim-holder fan-out writes appear beside registered identities' hints,
each row's own `to` naming its addressee; the ok page carries
`scope:'fleet'`, `wakes`, `matched` and `truncated` under the same
queue-tail semantics `readAgentWakes` documents, and the same
`job`/`from`/`excludeFrom`/`channel`/`contains`/`priority`/`before`/`thread`/`inReplyTo`/`bodyKind`/`result`/`id` filter set validates
and resolves referents identically — sender matchers resolve through
the registry with exact-label fallback, `channel` keeps only hints whose
own `to` label sits under `group:<name>:*` inside the queue-tail match,
filtered verdicts fail closed
`unavailable` on an unreadable bus store, and malformed filter values
answer `invalid`; an unreadable registry or wake queue answers
`unavailable`, never an empty page passed off as "no wakes"),
`listBusChannels(agent, options?)`
(the registry channels name-sorted with `createdBy`, `createdAt` and member
handles in join order — all of them, or only those one resolved identity
belongs to; `source` is `missing` for a verified-empty registry or
`available`, `agent` the resolved handle or null, and an unknown ref or
unreadable registry answers `unknown-agent`/`unavailable`, never an empty
list), `readAgentChannel(name, {topic, from, excludeFrom, thread, priority, job, matched, since, before, contains, inReplyTo, id, bodyKind, after, limit}, options?)`
(one oldest-first page of a registry channel's live posts addressed to
`group:<name>:*` — or one topic — with `group.presence` heartbeats
excluded; `from` filters by sender through identity-label matching,
`excludeFrom` drops posts sent under every registered spelling of one
identity through the same matcher — an unresolvable ref keeping
exact-label matching — composing with `from` so a sender both included
and excluded matches nothing, `thread` keeps only `note`/`context` bodies carrying that v2 thread label,
`priority` keeps only posts stamped with that exact P0..P3 band, and `job`
keeps only posts that name one job — the same `busBodyJobMatch` rule
`readAgentInbox`'s `job` applies: a `work.post`/`work.status`/`work.result`/`wake`
body declaring that `jobId`, a `worker-handoff` assigning that fleet job id
through `taskId`, or a `note`/`context` body carrying the `job:<id>` v2
thread label; `since` keeps only posts received at or after that epoch-ms
cutoff — the same `receivedAt >= since` match `readAgentInbox`'s `since`
applies; `before` keeps only posts received strictly before that epoch-ms
cutoff — the exclusive upper bound every bus read's `--before` applies —
composing with `since` into one `[since, before)` window on `receivedAt`;
`contains` keeps only posts whose scrubbed one-line summary —
the same text the inbox frame renders per row — carries the needle as a
case-insensitive substring, the same rendered-summary rule
`readAgentInbox`'s `contains` applies; `inReplyTo` keeps only posts whose
object body cites that envelope id through its own `inReplyTo` field —
the shared `busBodyInReplyToMatch` own-property exact match
`readAgentInbox`'s `inReplyTo` applies, never the `replyTo` alias or a
substring — so "which room posts answer envelope X" is one filtered read;
`id` keeps only the post whose own wire id is strictly equal to the
value — the same exact-envelope match `readAgentInbox`'s `id` and the
raw bus reads' `--id` apply, never a substring or a body citation — so
"did envelope X reach the room" is one filtered read; `bodyKind` keeps
only posts whose body carries that discriminator — the same
`busBodyKind` read `readAgentInbox`'s `bodyKind` applies: the v2 `kind`,
else a bus-transport v1 `protocol.kind`, else the `type`/`schema` a
kindless notice keys on, matched exactly and case-sensitively, a body
with no discriminator never matching — so "only the room's `work.result`
posts" is one filtered read;
`matched: true` scans the whole retained store and returns `matched`, the
count of every filter-matched post, while `messages` still caps at
`limit`; claimable work and worker-handoff posts additionally carry
`held`/`holder` — the same hold evidence `readAgentInbox` and
`readBusEnvelopeById` report, read once per page, `held` null when a hold
store cannot be read, never proven free — and bodies that declare a
`jobId` (`work.post`, `work.status`, `work.result` or `wake`)
additionally carry `job` (`BusEnvelopeLookupJob`), the live feed state of
the cited job resolved through the same one-read-per-page annotation
`readAgentInbox` applies; `nextCursor` covers every scanned row, a missing
registry answers
`unknown-channel`, and an unreadable registry or store answers
`unavailable`/`retryable`, never an empty page passed off as history),
`readBusEnvelopeById(id, options?)` (one retained envelope by its wire id —
the key wake hints, claim operations and `work mine` items cite — via the
same bounded page walk; live rows only so an expired or never-posted id
answers `not-found`, an unreadable store `unavailable`/`retryable`, the read
needs no identity, and `fromAgent` sender decoration is best-effort so an
unreadable registry never hides the envelope; claimable work and
worker-handoff bodies also report `held`/`holder` — whether a taken
message-id claim or live coordination hold covers the exact receipt, the
same rule `work mine` next/handoffs and the unified comms inbox apply —
with `held` null when a hold store cannot be read, never proven free. A
body that declares a `jobId` (`work.post`, `work.status`, `work.result` or
`wake`) also reports `job` (`BusEnvelopeLookupJob`):
`{jobId, feed:'ok', job}` with the claims-joined `BusWorkFeedJob` — `job`
null when the feed is healthy but projects no live job with the id, an
orphaned citation — `{jobId, feed:'refused', reason, receipt?}` when the
projection refuses, or `{jobId, feed:'unavailable'|'retryable'|'invalid'}`
when it cannot be read; the lookup still succeeds either way and an open
job's `claimable` stays the same tri-state `work feed --claims` reports.
A claim-holder `wh-…` wake-hint id that names no live envelope resolves
through the wake queue and the live terminal `work.status` receipts that
could have generated it — the same re-derivation `wakes` annotates — to
the citing receipt, returned with a `wakeHint` citation (`to` holder
label, `statusId`, `jobId`, `status`, optional `detail`); a hint with no
retained row or no reproducing receipt answers `not-found`, an unreadable
wake queue `unavailable`, never a guessed receipt. Envelope ids are
caller-chosen, so a real receipt always wins over hint interpretation),
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
render clipped to 512 characters. `workFeedJobId(body)` returns the
`jobId` a feed-citing body (`work.post`, `work.status`, `work.result` or
`wake`) declares, undefined for every other kind, and
`busBodyJobMatch(body, job)` is the shared job-scoped read rule — a
feed-citing `jobId`, a `worker-handoff` `taskId`, or the `job:<id>` thread
label — that `readAgentInbox`, `readAgentChannel`, `comms bus
read`/`watch --job` and `followBusStream` (`fleet bus-follow --job`) all
apply;
`busBodyJobIds(body)` is its set form — every job id the body names under
the same rule, sorted and deduplicated, so a body matches `--job` exactly
when the id is in the set — and the unified comms inbox carries it on each
item's `jobIds` (feed jobs by their id, bus/mailbox bodies by their
citations, board tasks by `itemId` with deliveries riding their thread's
citations, conversations by `thread.jobs`, wake hints by their cited job —
a claim-holder hint's `jobId` or a resolved referent's feed citation —
teammate tasks by `jobId`, seat
handoffs by `node-job` refs, peer-dispatch receipts by their peer-announced
`jobId`) for `comms inbox --job` to match against,
absent when no job relation is provable; `busReadContains(value)` and
`busReadContainsMatch(body, needle)` — bounded by `BUS_READ_CONTAINS_MAX` —
are the shared `--contains` validation and match every bus read applies:
`readAgentInbox`, `readAgentChannel`, `comms bus read`/`watch --contains`
and `followBusStream` (`fleet bus-follow --contains`) all run the same
case-insensitive whitespace-collapsed substring over the scrubbed
one-line summary, never the raw body, so a secret-shaped value stays
unfindable and protocol-v1 payloads stay opaque; `busBodyInReplyToMatch(body, inReplyTo)`
is the shared reply-citation match every bus read's `inReplyTo` filter
applies — an object body's own `inReplyTo` field strictly equal to the
cited envelope id, exact and case-sensitive, never the `replyTo` alias,
a substring or a non-object/array body — shared by `readAgentInbox`,
`readAgentChannel`, `readAgentMessages` (`phm messages`), `comms bus
read`/`watch --in-reply-to`, `followBusStream` (`fleet bus-follow
--in-reply-to`), `fleet_bus_inbox`'s `inReplyTo` and the
`fleet_agent_inbox`/`fleet_bus_channel`/`fleet_agent_messages` MCP
filters, so "who answered envelope X" can never disagree about what
counts as the answer; `busPageResumeCursor(page)`
is the one honest resume cursor every paged bus read's consumer reports —
a plain page's `nextCursor` already resumes strictly before the first
unshown row, but a `matched` page scans the whole retained store so its
raw cursor is the store's end and resuming there would skip every unshown
match, so when `matched` exceeds the shown rows the helper answers the
newest shown row's cursor instead (every unshown match sits beyond it,
every shown one at or before it) while a `matched` total that fits the
page keeps the store-end cursor — `phm agents bus inbox`, `phm agents bus
channel read` and the `fleet_agent_inbox`/`fleet_bus_channel` MCP adapters
all report this same cursor, so a matched read never disagrees about
where to resume; and `comms inbox
--contains` (`UnifiedInboxFilter.contains`, bounded by
`UNIFIED_INBOX_CONTAINS_MAX`) keeps only items whose scrubbed
`title`/`detail` — the text the row shows, never the `act` command links —
carries the needle as a case-insensitive whitespace-collapsed substring;
`UnifiedInboxFilter.kind` (`comms inbox --kind`, validated by
`isUnifiedInboxKind` over `UNIFIED_INBOX_KINDS`) keeps only items of that
stored kind — the item's own classification, finer than `source` where one
source emits several kinds (the `bus` source's `bus-work`/`bus-handoff`
split, the `board` source's `board-delivery`/`board-task` split) — and
ANDs with every other view dimension while the per-source `pending`
reports stay the unfiltered store truth;
and
`jobAnnotationFromFeed(feed, jobId)` maps one already-read
`BusWorkFeedReadResult` to the `BusEnvelopeLookupJob` every citing read
shares — the inbox page, `readBusEnvelopeById`, wake referents and the
`agent-messages.v1` `jobState` field. `labelIdentityOf(registry)` binds one
already-read `AgentRegistry` into the label→identity-key lookup every
sender filter shares — `readAgentInbox`/`readAgentChannel` `from` and
`excludeFrom`, `comms bus read`/`watch --from` and
`followBusStream` (`fleet bus-follow
--from` and `--exclude-from`, the latter dropping every label of the named
identity exactly as `readAgentInbox`/`readAgentChannel`
`excludeFrom`, `comms bus read`/`watch --exclude-from` and
`fleet_bus_inbox`'s `excludeFrom` do) — the value-side half of
`agentRefAddressMatcher`: retained envelope labels resolve through handle,
`agent:` address, stable id or
alias (exact match first, then lowercase), so a filter naming any registered
spelling of one identity matches every label of that identity, while the
caller-supplied ref itself resolves through `resolveAgent` exactly — a
case-variant or otherwise unregistered spelling keeps exact-label matching
and never inherits an identity's label set. `followBusStream` (`fleet bus-follow`)
applies the same narrowing the bus page reads share, so the stream and
`comms bus read|watch`/`fleet_bus_inbox` can never disagree about what a
filter keeps: besides the routing, job, priority, thread, since/before
window and contains dimensions above — `before` the exclusive
`receivedAt < before` upper bound composing with `since` into one
`[since, before)` window, the same match `comms bus read|watch --before`
and `fleet_bus_inbox`'s `before` apply — it also takes `id`/`inReplyTo` — the exact
envelope-id and own-property reply-correlation matches — `kind`/`topic` —
the protocol-v1 `protocolOf(body)?.kind` and `topicMatches` rules —
`bodyKind`, the `busBodyKind` own-field discriminator match the addressed
inbox/channel/wakes/conversations reads and `phm messages` share (the v2
`kind`, else `protocol.kind`, else the `type`/`schema` a kindless notice
keys on; exact and case-sensitive, a kindless body never matching) —
`result`, the `busBodyResultOutcome` own-field outcome match the
`WORK_RESULT_OUTCOMES` vocabulary `phm messages --result`, `agents
messages --result`, `fleet messages`, `bus recent`,
`fleet_agent_messages`'s `result` and the work feed's `--result` share
(only `work.result` bodies whose own `outcome` strictly equals the code
emit; a `work.release` body's own `released`/`completed` outcome, every
other body kind and a result carrying no outcome never match, and a value
outside the vocabulary is an invalid request) — and
`channel`, the raw `group:<channel>:` `to`-prefix the unaddressed bus reads
share (`comms bus read|watch --channel`, `fleet bus-follow --channel`,
`fleet_bus_inbox`'s `channel`, `wakes --channel`, `phm messages --channel`,
the work feed's `--channel`; the addressed `agents bus inbox --channel`
resolves the same prefix only across the agent's member channels), strict
channel-name grammar with no registry dependence — each
skipping non-matching rows while checkpoints still advance past them.
Claim tokens and `work.result`
queueId/receiptId never appear in a summary.
`parseUnifiedInboxQuery` (`src/core/comms/unified-inbox-query.ts`) is the
shared validation `GET /api/verse/comms/inbox`
(`src/core/verse/comms-inbox-api.ts`) applies to its query — `limit`
(1–200, default 50) plus the `UnifiedInboxFilter` dimensions `source`,
`kind`, `severity`, `blocking` (`true`/`false`), `job`, `since`, `before`
and `contains`, each at most once — `since` the inclusive appearance-time
lower bound, `before` (`UnifiedInboxFilter.before`, `comms inbox --before`)
the exclusive `<` upper bound composing with it into one
`[since, before)` window under the same `parseSince` grammar every bus
read applies, an item exactly on a boundary or unable to prove its time
staying out of the match — so the HTTP read narrows by exactly the
rules `phm comms inbox` and `fleet_comms_inbox` apply and passes the
resulting `filter` to `readUnifiedInbox`, echoing the report's applied
`filter` on the response; an unknown, repeated or malformed parameter or
value is a 400, never a silently ignored filter.
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
a `to` that resolves to a registered identity — any of its labels, exact
first then lowercase — lands in its inbox as
legacy mail.

`src/core/agents/bus-cli-adapters.ts`: `listBusCliAdapters()`, `getBusCliAdapter(cli)`,
`detectBusCli(env)`, `attachBusCliSession(input, env, options?)`, `busSelfFromEnv(env, options?)`,
`busAgentView(ref?, env, options?)` (the `agents bus id show [<ref>]` read — the
registered identity one ref resolves to plus its `agent:<handle>` address and
member-channel names, or the PHM_AGENT_ID self view that also reports the
detected session CLI; statuses `ok` with `self`/`ref`/`identity`/`channels`/
`address` (`cli` only on self), `unknown` for a well-formed unregistered ref,
`invalid` for a non-label ref, `unavailable` for an unreadable registry and
`unset` when the self path has no PHM_AGENT_ID — resolution is `resolveAgent`'s
exact-label rule, never case-folded, and the read is read-only),
`frameBusInbox(cli, messages)` renders each body through `busBodySummary`,
falling back to `busBodyFallbackSummary` for unrecognized bodies; items
carrying `held` show it inside the line's bracket, and items carrying `job`
show the shared `busInboxJobMarker` (`job=<id>:<state>` plus `result=<outcome>`
when the feed job cites a `work.result`, and `claimable=`
when the claims join computed it) the same way. `frameBusChannelRead(cli,
channel, messages)` renders a channel page through the same markers, scrub
and bound, each bracket naming `#<channel>:<topic>`. Identities
are routing names and grant no authority.

`src/core/agents/bus-status.ts`: `readUnifiedBusStatus(options?)` composes one
read-only probe over the twelve dependencies the unified verbs touch — the
message store (`inspectBusInbox` pass-through), the identity registry (counts,
null when unreadable), the wake queue (`state`, the observed hint count
before the row cap — 0 on a verified-missing queue, null when unreadable —
plus `truncated` for queue-tail or cap cuts, null when the state is
unknown), the shared coordination table (`listCoordination` — live claims and
status rows),
the message-id claim journal (`inspectBusWorkClaims` retained-record count),
the work-feed projection (job count, or the refusal `reason` plus the blamed
receipt's wire id as `receipt` when the projection named one), the legacy
`phm bus` mailbox store (`createBusMailbox(...).inspect()` under the fleet
root's parent — `source` plus a store-wide `pending` count of unacked,
unexpired messages across every recipient label, 0 on a verified-missing
store, null when unreadable; totals only, never labels), the owner-chat
share receipts ledger (`readOwnerChatReceipts` under the same fleet root —
`source` plus a retained `receipts` row count that `inbox`/`work mine`
require before showing `agent-chat-owner` envelopes, 0 on a verified-missing
ledger, null when unreadable), the shared task board with its fleet queue
(`BusBoard.inspect()` plus `SharedStore.readClaimIndex()` under the paths
`busBoardStoragePaths` derives — `source` plus stored `threads`, `tasks` and
`pendingDeliveries` counts, 0 on a verified-missing board, null when
unreadable, and a `claims` readability flag that stays null only when the
queue was never probed), and the bot-seat store (`inspectSeatStore` under
`<home>/.phantom/bots`, the same `SeatOptions.home` `work mine`'s seats
section resolves — `source` plus retained `seats` roster-row, `states`
seat-state-entry and `handoffs` journaled-record counts, 0 on a
verified-missing store, null for a file that cannot be read or validated —
the same failure that makes `planSeatHandoffs` throw, never a plan verdict,
seat contents or quota evidence), the agentnet peer work-dispatch journal
(`readWorkDispatchJournal` under the same root `consumePeerWork` resolves —
`agentnetPaths().busRoot` = `realHome()/.ashlr/fleet`, or the probe's `root`
override — `source` plus retained `receipts` and `unpublished` counts, the
latter applying the consumer's own `sent !== outcome` rule; 0 on a
verified-missing journal, null when unreadable, never peer names, claim keys
or bodies), the agentnet peer coordination ledger (`readPeerLedger` over
`<busRoot>/agentnet/coordination.json` under the same root the peer verbs
resolve — `agentnetPaths().busRoot` = `realHome()/.ashlr/fleet`, or the
probe's `root` override — `source` plus a `liveRows` count of unexpired
coordination rows the send budget still counts; 0 on a verified-missing
ledger, null when unreadable, never peer names, claim keys, digests, threads
or bodies), and — as a verdict over the claim journal and
coordination table rather than another dependency — the claim-store drift
comparison (`readClaimStoreDrift` run over the probe's own two reads, the
same `fleet.claim-drift.v1` read `ashlr fleet claim-drift` serves:
`claimDrift.state` VERIFIED/DRIFT/UNKNOWN with `matched` and per-kind
`busOnly`/`coordOnly`/`ownerMismatch` counts, every count null — never zero —
when the comparison cannot run), plus the outbound send gate every write
verb passes through — `sendGate.state` open/blocked/unknown over the
kill-switch sentinel's `readKillSwitch` verdict (`kill.state`
active/inactive/unknown with its `reason`) and the comms pause file's
`probePauseState` verdict (`pause.state` paused/clear/unknown with `since`
and `reason`), resolved under `realHome()` exactly as `localWriteGate`
resolves them, never the probe's `root` override; open means neither gate
blocks, blocked means at least one provably refuses, unknown means a
source could not be inspected — the send path fails closed on both, so
unknown is never open). Each section
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

`phm fleet messages --since <ts> [--before <ts>] --json` returns the map
reader's newest-first
`{from,to,kind,at,summary}` rows (null and exit 1 when unreadable); `--before`
keeps only rows received strictly before its cutoff, composing with `--since`
into one `[since, before)` window. `phm fleet map messages`, `phm fleet
messages` and GET `/api/fleet/map/messages` share the `phm messages` filter
vocabulary — agent/with, kind, priority, job, thread, channel, contains,
from/exclude-from, in-reply-to, id, body-kind, to and result (the
kind-scoped `work.result` outcome match `busBodyResultOutcome` applies,
validated against `WORK_RESULT_OUTCOMES`) — applied by the same
`matchAgentMessages` pipeline every bus read uses, so a filtered question
gets the same answer on each. The existing
`fleet.map-messages.v1` adds optional scrubbed `text` (8192 characters); receipts
are deduplicated by id before the since filter. The desktop's existing 2D/3D
map overlays these messages for 10 seconds; clicking opens the text in place.
`fleet.live-map.v1` also draws standing planners as `kind: "planner"` nodes.

## Approval actor (RQ-APPROVAL-ACTOR-1)

`src/core/approvals/actor.ts` exports `principalFromWebToken(token)`,
`agentActorForToken(token)`, `humanActorForPresence(token)`,
`approvalPresenceBytes(approvalId, decision)`, `invitePresenceBytes(team, op)`,
`verifyPresenceSignature(message, signature)` and `HumanPresenceRequired`.
A web token's principal id is `web-token.` plus 32 hex characters of SHA-256.
The raw token is never an actor id. `verifyPresenceSignature` checks a P-256
signature against the custody public key and does not sign.
`decideApproval(team, actor, approvalId, decision, options?)` records an agent
principal only when the pending approval is not human-required; otherwise it
throws `HumanPresenceRequired`. `options.presenceProven` accepts the enrolled
device human after that signature check and does not read agent env markers.
`decideTeamApproval` takes the resolved actor and does not call `localHumanActor`.
`POST /api/approvals/team/:id/decision` accepts `decision`, optional `team` and
optional `assertion`. An `actor` field is refused. A bare token on a
human-required decision is HTTP 403 `human-presence-required`.
