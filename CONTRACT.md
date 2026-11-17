# Lane allowance evidence

`src/core/usage/lane-allowance.ts` exports pure `projectLaneAllowance(inputs,
nowMs)` and read-only `readLaneAllowance({ runsDir?, weeklyFile?, nowMs? }?)`,
returning `LaneAllowanceSnapshot` (`v: 1`, `asOf`, `lanes`). Inputs combine
resource-live state/history, parsed posture evidence and published Devin weekly
capacity. Runs default to `ASHLR_RUNS_DIR` or `~/.ashlr-runs`; `weeklyFile`
overrides the Devin publication path. `LaneAllowanceInputs` and
`LaneAllowanceRow` describe nullable usage, reset, age, history, posture and
Devin preview evidence. Missing measurements stay null; stale values retain
their age and reason. USD pools map to `api-credit`, included/metered posture
classes pass through, and local, absent or unrecognized classes stay unknown.
`GET /api/usage/lanes` returns this projection without refreshing providers.
`postureEvidence(root)` is exported from `src/core/queue/route-explain.ts` for
the shared bounded journal parser, including optional `freePreview` and
`previewExpiresAt` evidence; absent optional fields remain absent.

# Frontier CLI discovery and daemon health

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
and snapshot persistence. Scanner bounds and observation ordering are unchanged.

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
cannot authorize claims or prove completion. No shell, engine, merge or spending
is invoked. Queue task strings remain untrusted data under existing worker gates.

`QueueJob` (RQ-SHARED-QUEUE-1) carries the optional market requirements
`max_tier` (tier ceiling; `tier` and `min_tier` may not exceed it), `data_class`
(`public|internal|confidential|restricted`) and `work_class`
(`bulk|standard|judgment`) beside `preferred_lane`, `needs`, `min_tier`,
`max_cost_class`, `exclusive` and `impact`; `validateQueue` refuses unknown
values, and `phm queue add` takes `--max-tier`, `--data-class` and
`--work-class`. `currentUnfed(statusJson, readyTsv)`, `foldUnfedHistory(jsonl,
nowMs, windowHours)` and `renderUnfed(report)` in
`src/core/fleet/unfed-capacity.ts` back `phm fleet unfed` (`fleet.unfed.v1`).

`QueueStore.claim(id, owner, intake?: {job: QueueJob; guard: () => void})` may
atomically insert a new READY job and claim it under the existing queue lock.
The optional synchronous host guard runs under that lock; an existing ID or an
invalid intake fails without mutation. The two-argument claim contract is unchanged.
`queue/decompose.ts` exports its existing `promptText(field, value, max): string`
validator for shared bounded, printable, secret-free queue prompt validation.

`PeerRequest.work?: z.infer<typeof workPostBodySchema>` is accepted only for a
directed task; its authenticated bus body is `work.post`, with the same enrollment
and audience checks. The CLI adds `phm agentnet peers post <to> <work-post-json>`
and `phm agentnet peers dispatch [--after <cursor>] [--apply] [--json]`.
Dispatch is a read-only preview unless apply is exactly true. Results use only
the local bus and its current comms/participant allowlist, never a Slack send.

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
checked before interpreting observations as complete.

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

## Devin weekly capacity

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
claim and work-feed schemas described in [Agent Bus v2](docs/AGENT-BUS.md#v2).
Routing labels, repo slugs and claim tokens reject trailing newlines; claim keys
reject ASCII controls including DEL. Claims grant no execution authority.

`projectBusWorkFeed(receipts: readonly unknown[], participants?: readonly Participant[])`
in `src/core/agents/bus-work-feed.ts` returns `WorkFeedResult`: either
`{status:'ok', feed:{v:2,jobs:WorkJob[]}}` or `{status:'refused',reason}`.
It validates at most 1024 retained receipts in strictly increasing cursor order;
legacy and unrelated bodies stay opaque. Posts start queued with `owner=from`;
provider comes from the post or explicit participant metadata (missing is refused).
Statuses update only retained jobs from the same routing owner; orphan statuses
are ignored. Duplicate job posts and malformed work bodies refuse the projection.
Latest cursor wins; `updatedAt` is its receipt time. Jobs retain post order.
This is a pure retained-snapshot projection, not a historical ledger or identity
check. It performs no I/O, transport, claim mutation or execution. Existing v1
journals/readers remain unchanged; feed output is explicitly versioned `v:2`.
No HTTP feed endpoint is provided by this foundation.

### Unified agent bus (RQ-BUS-UNIFY-1)

`src/core/agents/bus-identity.ts`: `stableAgentId(handle): string` (`agt_` + 20 hex),
`agentAddress(handle)`, `resolveAgent(registry, ref)`, `agentLabels(identity)`,
`readAgentRegistry(options?)`, `registerAgentIdentity(input, options?)`,
`createAgentChannel(input, options?)`, `joinAgentChannel(name, agent, options?)`,
`leaveAgentChannel(name, agent, options?)`. Results are status objects
(`created|updated|unchanged`, or `invalid|conflict|full|not-found|unavailable|retryable`
with a `reason`); they never throw for bad input or storage faults.

`src/core/agents/bus-unified.ts`: `sendDirectMessage`, `postChannelMessage`,
`sendHandoff` (all `Promise<UnifiedSendResult>`: `posted|duplicate` with `id`,
`cursor`, `to`, `wake`, or a refusal with `reason`), `readAgentInbox(ref, {after, limit}, options?)`,
`readAgentWakes(ref, sinceAt, options?)` and `shouldWake(priority, requested, handoff?)`.
Every send is one `appendBusInbox` post; wakes go through `createBusWakeHook`.

`src/core/agents/bus-cli-adapters.ts`: `listBusCliAdapters()`, `getBusCliAdapter(cli)`,
`detectBusCli(env)`, `attachBusCliSession(input, env, options?)`, `busSelfFromEnv(env, options?)`,
`frameBusInbox(cli, messages)`. Identities are routing names and grant no authority.
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

`src/web-ui/routes/verse/panes/pane-presence.ts` exposes `hasRegisteredPane(id)`,
`subscribeRegisteredPaneIds(listener)` (returns an unsubscribe function), and
`publishRegisteredPaneIds(ids)`. The registry publishes membership synchronously;
first-paint consumers observe it without importing pane definitions or shortcuts.

### Agent app adapters

`src/core/agents/apps/`: `AgentAppAdapter` (`describe`, `launchTask`, `listSessions`,
`readSession`, `sendMessage`, `readUsage` → `AgentAppResult<T>`), `createRegistry`,
`describeAgentApps` (`ashlr.agent-apps.v1`), `createAgentAppRegistry(deps?)`,
`createCliAgentApps(deps?)`, `createDesktopAgentApps(deps?)`. See [Agent app adapters](docs/AGENT-APPS.md).
