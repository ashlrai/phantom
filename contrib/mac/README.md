# Mac queue lane scripts (repo copies)

`restock.py` and `dispatchd.py` are reviewable repository copies of the
deterministic Mac queue scripts that run under `~/.ashlr-runs` on the dispatch
host. A repository snapshot can be older than the installed controller: compare
its exact input hash before adoption. Current-host changes under
`host-integration/` are surgical patches against their declared input, not
permission to overwrite the whole controller with an older copy. Changes land
by PR review and the adoption owner verifies immutable source hashes before any
live install. The queue scripts are deterministic and do not create tokens.
The candidate launcher denies Devin model IDs ending in `-lightning`, logs
`PAID_MODEL_BLOCKED`, and uses `swe-2-max` instead; host adoption needs a Security pin.

`restock.py` claims eligible `READY` lines from `router-queue.md` into lane
prompts (`ready.tsv`/`claimed.tsv`) for the fleet allowlist repos only, keeping
the READY stock at >=30% `bet=bold` and parking security-pinned surfaces as
`HOLD-SECURITY`. Lines whose `after=` dependencies are not yet landed are written
as `PARKED-DEP.<lane>` rows with a `DEPENDENCY GATE:` id list in the prompt
(RQ-QUEUE-AUTOUNPARK-1). Each restock tick re-reads those prompts; when
`metrics/jobs.jsonl` shows every gate id `MERGED`, restock rewrites the row to a
normal launch line and logs `UNPARK <job> deps=<ids>`. Unpark never rewrites the
prompt body, so prose like `no merge without Security pin` stays put — unpark is
not a merge. `phm fleet parked --json` lists the same parked rows and reports
still-unmet gate ids under `unmetDeps`. Merge-rate parked Phantom rows recover promptly up to the available capacity below 150 open PRs, with reservations preventing repeated ticks from spending the same capacity. A reservation for a vanished job is released after an hour; queued, running, worktree and published jobs keep their reservations. Legacy aggregate reservations remain conservative until the observed PR count rises. At saturation, one hourly probe can recover. The dispatcher’s count must be less than 10 minutes old. Missing, stale or
invalid counts leave rows parked; the count measures backlog, not merge rate.
Eligible jobs are reconsidered by first observed parking time, with queue order
breaking ties. A re-parked job keeps its reservation for an hour before retry;
it cannot spend a second reservation while the first is outstanding.
The dispatcher refreshes that count and wakes the restocker while such rows
remain, even when normal lane queues are full. Concurrent queue rewrites preserve
recovered rows; recovery shares its capacity reservations and probe cooldown.
Rows are considered in queue order. Duplicate identities, active claims,
worktrees, published jobs and recorded merges stay parked while later eligible
rows can recover. Resolve duplicate rows before retrying that job.
Recovery keeps the prompt and normal checks intact, and logs `UNPARK <job>
reason=MERGERATE` and `observed_wait_seconds` (time since first observed parked, a lower bound on actual wait). The restocker needs a Security re-pin before live installation.
The enqueue history in `claimed.tsv` does not block recovery; duplicate queue rows,
dispatch and batch markers, worktrees, published jobs and recorded merges still do.
`dispatchd.py` is the per-tick
supervisor: it reaps finished jobs, adapts per-lane slot targets inside
`slots.json`, launches queued lines, and fires the restocker when a lane's queue
runs shallow. Restock changes need a Security re-pin before the live `bin/` copy
is installed; do not install into `bin/` from an agent.

Devin routing policy (RQ-DEVINROUTEDEFAULTQ7, DEVIN-LEVERAGE-20261026): a line
that leaves its pool open (`pool=any` or no `pool=` attr) and is `tier=frontier`
or carries a long-horizon marker (`horizon=long`, `long-horizon`) routes to
`pool=devin` by default, matching how queuegen stamps new lines. Explicit
`pool=` values always win. Devin's seeded defaults are target 6, floor 3, ceiling
10 and `hard_cap` 10 (the live values; raise them per host in `slots.json`):
restock never overbooks past the ceiling, and dispatchd's raise logic stops at
it. When more than 3 of the last 10 devin completions end without a PR (abort
or empty, versus the 5% baseline of 2 in 40), dispatchd steps the devin target
down by 2, never below the floor 6, and at most once per new completion
(`step_seen` in `slots.json`). A held devin lane never adjusts. The devin lane
sits in dispatchd's restock trigger loop beside the codex lanes.

Starvation admission (RQ-LOADGATE-RETUNE). Claims stop on macOS
`kern.memorystatus_vm_pressure_level >= 4`, swap growth greater than 2 GiB
within the last 300 seconds, or free disk below `DISK_HARD_STOP_GB` (30 GB).
Swap samples persist across ticks in `admission.json`; startup needs a prior
sample and expired samples do not trip. Missing pressure or swap probes warn.
Load above 3 x ncpu halves the four new claims per tick to two, without tripping.
Process count above 2500 only warns. Worktree count above 40 only warns and
counts existing directories whose job is in the live `alive` set. Stale daemon
status also only warns. The ramp pauses only on a hard trip. Running jobs are
also capped fleet-wide at `min(sum of unheld lane targets, adaptive cap, hard_cap)`
(see [Adaptive concurrency and batching](#adaptive-concurrency-and-batching)). Every
pool has a `hard_cap` in `slots.json`. The file may also carry a top-level `hard_cap`,
which is now an optional operator ceiling with no default. The stored pool floor,
ceiling and target are clamped to the pool `hard_cap` every tick, immediately after the autopilot's `budget-overrides.json` floor and
ceiling are reapplied, so neither the overrides nor the ramp can lift a pool
past its `hard_cap`. dispatchd writes `queue/admission.json` (also embedded in
`status.json`) and logs `LOADGATE tripped|clear` once per change. `phm pool
admission --json` reports the same verdict read-only. `ashlr fleet admission --json`
reads the embedded block and says, per lane, whether work is held, at target,
blocked by the global cap, or ok. `queue/LOADGATE_OFF` is the
owner's off switch. The `codex-local` mid-tier cap is 4 while the gate is clear
and load is below `ncpu`, 2 at or above `ncpu`, and 1 while the gate is tripped.
`LOCAL_MID_CAP` overrides this cap with a nonnegative integer; the effective value
is recorded as `local_mid_cap` in `admission.json`.

Threshold environment overrides: `GATE_PRESSURE_MIN=4`, `GATE_SWAP_GROWTH_GB=2`,
`GATE_SWAP_WINDOW_S=300`, `GATE_LOAD_PER_CPU=3`, `GATE_PROCS_MAX=2500`,
`GATE_WORKTREES_MAX=40`, `GATE_TICK_MAX_S=900`, `GATE_STATUS_TIMEOUT=30`,
and `DISK_HARD_STOP_GB=30`. Gate limits accept positive finite numbers.
`dispatchd.admission.v2` records all signals, thresholds, warnings, claim limit,
swap samples and the `admit`, `halve_claims` or `stop` decision. Signal fixtures
`LOADGATE_LOADAVG`, `LOADGATE_NCPU`, `LOADGATE_PRESSURE`, `LOADGATE_SWAP_GB`
require `$HOME/.ashlr-runs/LOADGATE_TEST`; disk fixtures separately require
`DISKGUARD_TEST` and `DISKGUARD_FREE_GB`.

Security (606e84d2) must pin the merged dispatcher SHA before Masbot installs.
Use the sanctioned fork `publish.sh` workflow with auto-merge when publishing.

Install semaphore: `install-gate.py -- npm ci` takes `flock` on `queue/install.lock`
so at most one `npm ci` / `pnpm install` / `bun install` runs fleet-wide; others
wait (30 min default, then exit 75). The holder is written into the lock file
while held and the kernel drops the lock if the holder dies. `install-gate.py
--shims DIR` writes `npm`, `pnpm` and `bun` shims that route installs through the
gate; put DIR first on the PATH that `launch.sh` gives the agent. `launch-gate.sh`
does exactly that: the pinned `launch.sh` sources it (one line, see below) and it
writes the shims into `~/.ashlr-runs/install-shims` and prefixes `PATH`, failing
open if the shims cannot be written.

Per-tick budget (RQ-TICK-BUDGET): `dispatchd.py` runs its bounded external calls
(git-safe, `gh`, `lsof`, `precheck.sh`, the finish metric's `git`) through `_run`,
which starts the child in its own session and, on timeout, kills the whole process
group so grandchildren (`git fetch` under `precheck.sh`) cannot pile up; calls over
5 s log `SLOW`. After `TICK_BUDGET_S` seconds (default 90) the optional work waits
a tick: extra reaps and new empty-run prechecks. Disk guard: below
`DISK_REUSE_ONLY_GB` (100) free only FIXUP/LAND/SALVAGE reuse launches; below
`DISK_HARD_STOP_GB` (30) nothing launches (`DISKGUARD hard_stop` event) while reaps
still run to free space.

## Queue wait and dispatch priority

The dispatcher writes `enqueue` on first observation of a ready job, including
while admission is paused or its lane is held. `queue/run/<job>.enqueued`
receipts prevent duplicate enqueue events across ticks. `claim` is written after
precheck and admission succeed, immediately before spawning the launcher. Both
records carry `job`, `repo`, `lane`, `tier` and the event timestamp `ts`.
Pair enqueue and claim by job to measure observed queue wait; prompt creation
and launch are separate phases. Observation starts at the dispatcher snapshot,
so time between a writer appending and the next snapshot is not measured.
Requeues of the same job retain their original enqueue observation.

Ready jobs and finished worktrees use these priority buckets: `RQ-FIX-MAIN-*`
first, then `RQ-REL-*`, `RQ-DESK-*`, LAND/FIXUP/RECUT (with or without `RQ-`),
and all other jobs. Within each bucket the repo order is `phantom`,
`phantom-secrets`, `locus`, `lexicon`, `ashlr-md`, `ashlr-stack`, `ashlr-plugin`,
then unknown repos. Smaller numeric `size<=` hints in the task envelope sort
first; absent or invalid hints sort last, followed by path as the final tie
breaker. The repo comes from ready.tsv field 2 or the saved launch line when
reaping. The full order applies across lanes and replaces the lane cursor.

At most one launched, unfinished `RQ-FIX-MAIN-*` job per repo may run at a time,
including launch grace before its worktree exists. Explicit worker exit or
publish result releases that reservation. Sibling fixes remain in ready.tsv;
the dispatcher continues scanning for eligible work. All admission, disk, local
health and capacity checks still apply. If process enumeration fails, an
unfinished fix keeps its repo reservation until liveness recovers or completion
is explicit.

Publish handoffs use the same key and run one at a time, including across ticks,
so concurrent reapers cannot reverse entry into the publisher's auto-merge
step. The external `reap-one.sh` remains responsible for the sanctioned
`publish.sh` and auto-merge operation, and must wait through auto-merge
enablement before exiting. Its process blocks new handoffs even if
it has already removed its `.base` file. A new `.reaping` marker covers process
startup for 120 seconds; with a successful process snapshot, an older orphan
marker holds its own job but does not stop unrelated publishing. This changes
throughput to one handoff per tick.
The reaper consults the job ledger before handoff: a merged outcome for the
current launch, including one linked through its published PR URL, prevents a
leftover `.base` from triggering another publication. Repeated handoffs for an
unfinished attempt record its finish only once; a later launch starts a new
attempt. These records do not remove the worktree or replace publisher recovery.
The shared ledger reader also recognizes terminal records written by
`metrics-outcomes reconcile`, including records written before a restart; their
position in the ledger preserves the same launch boundaries. Reconciled PR outcomes
are matched to the current attempt by URL, including when reconciliation finishes
after a retry has launched; a previous PR cannot complete the new attempt.

## Adaptive concurrency and batching

RQ-QUEUE-BATCH-1 retires the fixed fleet cap of 18 and the `ncpu` bound beside it.
Agent sessions mostly wait on model APIs, so the host's own signals decide.
`concurrency.py` makes one decision per tick, using additive increase and
multiplicative decrease, and keeps its state in `queue/concurrency.json`:

| Signal | ok (headroom) | danger (back off) | Starvation gate trips at |
|---|---|---|---|
| load1 / (ncpu x `GATE_LOAD_PER_CPU`) | < 0.5 | >= 0.8 | warns only at 1.0 |
| `kern.memorystatus_vm_pressure_level` | 1 | >= 2 | 4 |
| `memory_pressure` free % | >= 25 | < 15 | n/a |
| swap growth in the gate window | < 0.25 x `GATE_SWAP_GROWTH_GB` | >= 0.5 x | 1.0 x |
| free disk | >= 2.5 x `DISK_HARD_STOP_GB` | < 1.5 x | 1.0 x |
| processes / `GATE_PROCS_MAX` | < 0.7 | >= 0.85 | warns only |
| fork failures (15 min) | 0 | >= 1 | n/a |
| provider 429 / overload hits (15 min) | 0 | >= 3 | per-lane halving |

- **Raise**: +2, at most every 120 s, and only when every signal is ok and the cap
  is the binding limit: running sessions are at the cap, work is queued, and the
  unheld lane targets sum above the cap.
- **Back off**: x 0.75 (at least -1) when any signal is in danger, at most every
  60 s. A fresh fork failure backs off at once. Fork failures are detected from
  `EAGAIN`/`ENOMEM` on the launcher spawn and from fork errors in a failed launch
  log (`FORK_FAILED`).
- **Hold**: on anything between ok and danger, and on any unknown signal.
- **Settle**: a backoff records the cap it started from (`trouble_cap`). Raises stay
  below that cap for 15 minutes, then probe one session at a time. The cap settles
  just under the host's real limit instead of oscillating.

The first tick seeds the cap at `max(4, min(18, ncpu))`, the old effective cap, so
nothing jumps on install. The cap stays between a floor of 4
(`ASHLR_CONCURRENCY_MIN`) and a ceiling of 64 (`ASHLR_CONCURRENCY_MAX`). A
top-level `slots.json` `hard_cap` set by the operator lowers that ceiling. The
`hard_cap` of 18 that older ticks seeded is dropped once, on the controller's first
tick. A malformed value fails closed to 18. Every change is logged as
`CONCURRENCY <from>-><to> <reason> (<signals not ok>)` in `dispatch-events.log` and
as a `concurrency` event in `metrics/jobs.jsonl`. `admission.json` carries
`concurrency_cap`, `_floor`, `_ceiling` and `_zones`. `status.json` adds a
`concurrency` block with `settled_6h`, the time-weighted cap over six hours.
`python3 concurrency.py [state.json]` prints the same summary.

**Batching.** `batcher.py` lets one session handle many related tasks. When a
launchable job has at least 2 related ready peers (same repo and tier, and the same
area: the source directory its prompt names most, such as `src/core/queue`), dispatchd
launches them together as `RQ-BATCH-<REPO>-<AREA>-<hash>`. Prompts without paths group
by job family (`RQ-PHX-*`). Tasks from areas too small to batch alone merge per repo;
they never take members from an area that can batch alone. Batches are evened out
(n tasks over `ceil(n / size)` batches) and are bounded by 200 000 prompt
characters. These never batch: release (`RQ-REL-`), desktop (`RQ-DESK-`), main-repair
(`RQ-FIX-MAIN-`) and PR-maintenance kinds (`LAND`, `FIXUP`, `RECUT`, `SALVAGE`,
`CONSOLIDATE`, `CLOSE`), plus `codex-local`, parked, kept and retired jobs.

The batch prompt (`queue/prompts/<batch>.md`) tells the session to fan out
subagents. It also carries a per-task checklist that the session keeps in
`BRIDGE_NOTES.md`, one line per task:
`- [x] <JOB> — done: ...` or `- [ ] <JOB> — failed|skipped|deferred: ...`.
`queue/batches/<batch>.json` records the members, their original ready lines and
prompts. Each member gets `queue/run/<job>.batched` while the batch runs (a
duplicate ready line is dropped as `SKIP_BATCHED`) and a `batch_claim` metric.

At reap, every member gets its own `task_outcome` metric (`done`, `skipped`,
`failed`, `deferred` or `unreported`). Members that are failed, deferred or
unreported go back to `ready.tsv` as individual lines. A task runs in at most 2
batches (`<job>.batch-attempts`) and then only solo. The `BATCH_REAPED` event
summarises the counts. The batch per-job precheck is skipped, because the session
checks each task.

Batch size starts at 16 per lane and stays between 4 and 64
(`queue/batch-tuning.json`). After each reap it grows x 1.25 when at least 85% of
tasks are done or skipped within 4 h. It shrinks x 0.7 below 60%, on a timeout, or
when the lane's batches complete fewer tasks per session-hour than its single
sessions. The lane is the one with the most tasks per session-hour among the lanes
the router proposed for the members that have a free slot (3 or more sessions of
history; otherwise the lead's lane). Batches never move to a lane the router did
not propose. `python3 batcher.py report [--json] [--window-h 168]` prints tasks per
session-hour and per million tokens by lane and by mode (single vs batch): the
before/after comparison. Only PR-published work counts. `queue/BATCH_OFF` is the off
switch.

## Installing the dispatcher

`install.sh` diffs `dispatchd.py`, `concurrency.py`, `batcher.py`, `install-gate.py` and `launch-gate.sh` against
`~/.ashlr-runs/bin` (or `$ASHLR_RUNS_BIN`, or `--bin DIR`) and installs the ones that
differ, copying each replaced file to `<file>.bak-macdispatch-<YYYYmmdd-HHMMSS>`
first. It prints the new sha256 of every file for Security to pin, refuses symlink
destinations, never creates the target directory, and touches nothing else. It does
not install `launch.sh` (a pinned, host-managed file): add the line
`. "${ASHLR_RUNS_BIN:-$HOME/.ashlr-runs/bin}/launch-gate.sh"` to it before the agent
starts. **Do not run it against the live directory until Security has reviewed
`install.sh` and `dispatchd.py` and updated the pins (G1-CODE-PIN, `GS_SHA`).**

```sh
contrib/mac/install.sh --dry-run          # show the diff, write nothing
contrib/mac/install.sh --dry-run --json   # machine-readable plan
contrib/mac/install.sh                    # install with timestamped backups
contrib/mac/install.sh --json             # same, one JSON object (schema macdispatch.install.v1)
```

`install.sh` covers the dispatcher lane only. [fleet/sync.py](../../fleet/README.md)
is the manifest-driven generalization for all `~/.ashlr-runs/bin` machinery —
same diff/backup/sha-verify semantics plus rollback, pinned-file drift reports
and an unmanaged-file sweep; it is the adoption path once Security re-reviews
the installer.

Afterwards `shasum -a 256 contrib/mac/dispatchd.py ~/.ashlr-runs/bin/dispatchd.py`
prints the same digest twice, and a second `install.sh` run reports every file
`unchanged`.

Fixture tests run both scripts against a synthetic `~/.ashlr-runs` under a
temporary HOME and never touch the live queue:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```

# Job outcome reconciliation

Run `./contrib/mac/metrics-outcomes reconcile --jobs /path/to/jobs.jsonl` before
reading the outcome metrics. This requires Python 3 and an existing authenticated
`gh` installation. It creates no tokens and does not publish or merge PRs.
Account access must be commissioned through Locus by the operator.

The ledger must already exist. Each publication is a JSON object with
`outcome: "PUBLISHED"`, a string `jobId`, and a `prUrl` containing the full base
repository GitHub PR URL. The legacy names `status`, `job` (or `id`), and `pr`
are also accepted. Other routing metadata is preserved. Blank lines are ignored;
malformed JSON refuses reconciliation without repairing or truncating the ledger.

Each unique job and PR is resolved with `gh pr view URL --json
state,mergedAt,closedAt`. Fork heads and squash merges need no special inference:
the PR's state is authoritative. Open PRs produce no outcome. Terminal events
retain the publication's field names, set `ts` to GitHub's merge or close time,
and include `mergedAt` or `closedAt`, `reconciledAt`, and a reconciler `source`.
Thus a historical backfill belongs to the actual merge/close window rather than
the time the repair ran. Existing MERGED or CLOSED job/PR pairs are never appended
again. This command reconciles published jobs only, not every PR in a repository.

A sibling `jobs.jsonl.reconcile.lock` serializes reconciler processes. Each append
is flushed and synced. Other ledger writers should use the same advisory lock
when appending to avoid racing reconciliation. The command rereads the ledger
before each lookup/append, preserves all original bytes and adds a missing final
newline. It never rewrites historical events. Keep the lock file in place.

Failures produce a nonzero exit and a count in the JSON summary; successful PRs
still reconcile. Failed and open PRs are retried next run. Diagnostics omit raw
GitHub output to avoid exposing credential-helper messages. A malformed ledger
or unavailable executable also fails closed. No live GitHub lookup is needed for
the fixture suite:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```

# PR titles for the bridge publisher

`contrib/mac/pr-title.sh` prints one `type(scope): summary` line at or under 72
characters for a job's pull request, or the job id when no better source
resolves. It never contacts GitHub and never fails after argument validation.
Set `PHANTOM_ROOT` to this checkout. In the external `~/.ashlr-runs/bin/publish.sh`,
keep the job id in the PR body (the existing `Automated bridge job \`$J\`` line)
and replace the literal `--title` argument with:

```bash
title=$(bash "$PHANTOM_ROOT/contrib/mac/pr-title.sh" "$J" "$R/$J.job-line" "$R/$J.diff")
gh pr create --repo "$REPO" --head "masonwyatt23:$BR" --base "$DEF" --title "$title" --body-file "$R/$J.body.md"
```

`$R/$J.job-line` is the router queue line the publisher already reads;
`$R/$J.diff` is optional; write `git diff "$BASE" "$TREE"` there before the
title call to let a loopback-only local model summarize the diff instead
(`PR_TITLE_MODEL`/`PR_TITLE_MODEL_URL` configure the endpoint; the model answer
is sanitized to one printable line and any error falls back to the router-line
title, then to the job id). The helper's own extraction drops the `JOB (meta):`
envelope and a leading `VISION` marker, keeps the first task sentence, infers a
conventional type, and scopes from `repo=`. Host deployment of the changed
`publish.sh` stays an owner step under the security pin.

Verification:

```sh
HOME=$(mktemp -d) npx vitest run test/pr-title.test.ts test/publish-sh-title.test.ts
```

# Mac bridge worktree disk pruning

`wt-prune.sh` reclaims ignored build directories from finished and kept but idle
Git worktrees physically under `~/.ashlr-runs`. Install it next to the #1066
queue scripts. It needs Bash 3.2+, Python 3.9+, Git, and macOS `lsof` (Linux
uses `/proc`). No credentials or network access are needed.

```sh
bash contrib/mac/test-wt-prune.sh
contrib/mac/wt-prune.sh --dry-run
```

The only removable directories are `target/`, `node_modules/.cache/`, `.turbo/`
and `dist/`, including those in nested packages such as `desktop/src-tauri/`.
Dependencies outside `.cache` remain installed. All candidates must be ignored
by repository Git rules and contain no tracked or unignored files, symlinks,
hardlinked files, special files, mount crossings, or nested repositories.

A worktree is eligible only when **every descendant's modification and change
timestamps are at least 20 minutes old**, no process has its cwd inside, and
the bridge's worktree lease and owner claim allow it. The pruner uses the same
persistent `locks/SHA256(canonical_worktree).lock` flock as the bridge and
never overwrites its metadata. Live owner or supervisor PIDs veto cleanup even
after moving cwd. Invalid claims and failed inspections preserve the worktree.
Launchers must acquire this same lease before reusing a kept worktree.

`~/.codex*`, `~/.ashlr-runs/queue`, symlinked run roots/worktrees, and worktrees
outside the run root are excluded. Sidecar paths cannot expand the boundary.
Run from outside a candidate worktree: the invoking shell's cwd also counts as
live. This is artifact cleanup, never `git worktree remove` or branch deletion.

## WT_REMOVED and the 30-minute sweep

This checkout does not contain the deployed `launch.sh`, `publish.sh`, or event
dispatcher. The adapters below are installation steps for that external bridge;
adding these files alone does not activate a service. No launcher, publisher,
release configuration, or CI configuration is changed by this contribution.

`wt-prune.sh` and `wt-prune.py` are class `managed` in
[fleet/manifest.json](../../fleet/manifest.json): install them together to the
bridge directory with `python3 fleet/sync.py --apply` (dry-run first, same
Security re-pin rule as `install.sh`), then run `wt-prune.sh --dry-run` before
enabling cleanup. At the existing `WT_REMOVED`
handler, after releasing the worktree lease and leaving its cwd, invoke:

```sh
"$BRIDGE_DIR/wt-prune.sh" --event WT_REMOVED
```

This sweeps remaining finished and kept worktrees. An optional absolute path
restricts the sweep to one worktree:

```sh
"$BRIDGE_DIR/wt-prune.sh" --event WT_REMOVED "$REMOVED_WORKTREE"
```

An event is a trigger, never an exemption from the safety checks. An already
removed path is a no-op. Directories lacking Git metadata cannot be qualified
and are preserved. Older launchers storing worktrees under `Projects/.../wt`
are outside this task's boundary and are preserved.

For periodic cleanup, install **one** of these options (off until installed):

```sh
# crontab: substitute the installed absolute script and log paths.
*/30 * * * * /path/to/mac-bridge/wt-prune.sh >> /path/to/wt-prune.log 2>&1

# Or supervise this process; it sweeps immediately, then every 1800 seconds.
/path/to/mac-bridge/wt-prune.sh --watch
```

Both modes accept `--dry-run`. The dry run inspects artifacts without deleting
them; it can create persistent lease files needed for coordination. Overlapping
event and periodic runs skip busy worktrees. A failed global inspection exits
nonzero; `--watch` retries at its next interval. Individual unsafe worktrees
increase `held` without blocking other worktrees. Logs contain counts only:

```text
WT_PRUNE freed_bytes=8192 would_free_bytes=0 removed=1 held=0
```

`freed_bytes` sums allocated file blocks successfully removed, and dry runs
always report zero there with an estimate in `would_free_bytes`. APFS clones,
snapshots, compression and directory metadata can make physical free-space
changes differ. No paths, process arguments, environment values or secrets are
printed. Partial failures retain a conservative successful-removal count.

## Optional shared Rust builds for launch.sh

These environment options are **flag-off by default**. Add this opt-in block
to the externally managed launcher before it starts the agent. `REPO` here is
the launcher's validated repository slug (for example `phantom`), shared by
that repository's worktrees, never a job or branch name.

```sh
if [ "${ASHLR_SHARED_CARGO_TARGET:-0}" = 1 ]; then
  case "$REPO" in ''|*[!A-Za-z0-9_.-]*|.|..) exit 2;; esac
  export CARGO_TARGET_DIR="$HOME/.cache/ashlr/cargo-target/$REPO"
  mkdir -p "$CARGO_TARGET_DIR"
fi
if [ "${ASHLR_SCCACHE:-0}" = 1 ]; then
  command -v sccache >/dev/null 2>&1 || exit 2
  export RUSTC_WRAPPER=sccache
fi
```

Enable either flag only for launches that should use it, for example:

```sh
ASHLR_SHARED_CARGO_TARGET=1 ASHLR_SCCACHE=1 /path/to/launch.sh JOB phantom POOL
```

When launching through `scripts/bridge/launch.sh`, `ASHLR_SCCACHE=1` is handled
there (local-only, see `docs/BRIDGE-WORKTREES.md`) and this block is unnecessary.
Install `sccache` separately before opting in. No installation, credential,
remote cache or provider configuration is performed here. Cargo serializes
concurrent builds sharing a target directory; this saves disk and repeated
compilation at the cost of possible build-lock waits. Keep different repositories
in separate target directories. Shared output and the optional sccache cache
live outside `~/.ashlr-runs` and are never pruned by this helper. Existing
caller-provided Rust environment settings are unchanged when the flags are off.

# Staged-push drain trigger

`staged_drain.py` is one deterministic tick for the Mac host, a pinned repo copy
like `dispatchd.py` and `restock.py`. Install `staged_drain.py` and
`staged-drain.sh` next to the #1066 queue scripts and fire the tick from launchd
(`com.ashlr.staged-drain.plist.in`) or from a dispatchd tick. There is no model
turn and no token creation; the only network call is the read-only
`gh api repos/ashlrai/<repo>/actions/runs?status=queued --jq .total_count` poll
across `locus`, `lexicon`, `ashlr-md`, `ashlr-stack` and `ashlr-plugin`.

Each tick reads `$STAGED_DRAIN_WORK/staged-pushes.tsv` (default
`/workspace/phantom-work/staged-pushes.tsv`). While the summed queued-run total
is 50 or more, or the poll fails, the tick holds and changes nothing. Below 50
it drains the file in row order under a `staged-pushes.tsv.lock` advisory lock;
a busy lock holds the tick rather than piling up waiters.

- `PARKED` rows are skipped and left untouched.
- A row touching any `.github` path component, or any component starting with
  `release` (dot-optional), is never pushed: the staged state is committed via
  a scratch index onto the local branch `staged-drain/<job>` and the diff lands
  at `handoff/<job>.diff` for manual handoff. The worktree's own HEAD, branch
  and index are never moved. When the host `scrub.pl` is installed
  (`STAGED_DRAIN_SCRUB`, default `~/.ashlr-runs/bin/scrub.pl`), the diff passes
  its `--check --allow-fixtures` gate before it is written.
- Every other staged row goes to the pinned publisher only:
  `STAGED_DRAIN_PUBLISH <job>` (default `~/.ashlr-runs/bin/publish.sh`, the
  mac-bridge publish.sh install path). The drain itself never runs git push,
  fetch, pull or any remote command, and publisher output is never printed.
- Each processed row is marked `done` or `failed` in place with a route note;
  comment, blank, terminal and malformed lines are preserved verbatim.

TSV row schema v1, one tab-separated row per staged push:

    job<TAB>repo<TAB>worktree<TAB>base<TAB>status[<TAB>files][<TAB>note]

`status` starts as `staged`. `files` is an optional comma-separated list of
repo-relative paths; it is unioned with a read-only inspection of the worktree
when one is available, so an under-reported `.github` drift still routes to
handoff. `repo` must be on the seven-repo allowlist and `base` a hex commit.
Job ids are restricted to `[A-Za-z0-9._-]`, no `..`, never `.lock`-suffixed.

Logs carry one value-free line per row (`row`, `job`, `outcome`, `route`,
`reason`) plus gate and summary counts; no paths, file contents, arguments or
environment values are printed. `--dry-run` reports the gate result and each
row's route plan without draining, rewriting the TSV, invoking the publisher
or writing handoff diffs:

```sh
STAGED_DRAIN_WORK=/path/to/work bash staged-drain.sh --dry-run
```

launchd install sketch (substitute the deployed paths):

```sh
sed -e "s|__STAGED_DRAIN_SH__|/path/to/mac-bridge/staged-drain.sh|" \
    -e "s|__INTERVAL__|300|" -e "s|__LOG_DIR__|$HOME/.ashlr-runs/logs|" \
    -e "s|__HOME__|$HOME|" -e "s|__PATH__|$PATH|" \
    -e "s|__WORK__|/workspace/phantom-work|" \
    -e "s|__PUBLISH__|$HOME/.ashlr-runs/bin/publish.sh|" \
    com.ashlr.staged-drain.plist.in > ~/Library/LaunchAgents/com.ashlr.staged-drain.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.ashlr.staged-drain.plist
```

Fixture tests run a synthetic work dir under a temporary HOME and never touch
the live queue or GitHub:

```sh
HOME=$(mktemp -d) python3 -B -m unittest contrib/mac/tests/test_staged_drain.py -v
```

Restock and dispatch share `launch_precheck.py`. Only exit 10 with an exact
job-matching merged/closed PR receipt proves completion. Restock also excludes
exact jobs with recorded `MERGED` outcomes before creating prompts or claims;
an explicit repository must match (legacy outcomes use fleet-wide job IDs).
Restock keeps exit 11–13 rows READY with bounded retries recorded separately in
`queue/restock-precheck-parked.json`. They consume neither lane slots nor target
file/PR reservations, so actionable siblings can fill demand in the same pass.
Each pass runs at most the larger of 20 prechecks or total lane demand.
Retry and NOOP history is tied to task content; revised work retries immediately.
Errors and timeouts keep the existing fail-open behavior;
dispatch checks again at launch. In dispatch, legacy code 13 means acceptance
unproven, not completion. The job remains in `ready.tsv` with per-job retry
state in `queue/precheck-parked.json`: delays double from one minute to a
one-hour cap. Waiting jobs consume no precheck budget; due jobs wait if the
budget is exhausted. One `precheck_parked` metric replaces repeated code 13
skip events for unchanged inputs. A prompt or routing change resets the delay;
a successful retry clears it. Other runnable jobs continue through the queue.
Host installation still requires Security review and re-pinning. Preview without changing queue files:

```sh
python3 contrib/mac/restock.py --dry-run --json
# {"dry_run": true, "queued": 0, "done_noop": ["RQ-EXAMPLE"], "skips": {"done-noop": 1}, "unpark": [], "parked_dep": []}

# Parked dependency rows still waiting on MERGED outcomes (read-only):
phm fleet parked --json
# … "unmetDeps": [{"job":"RQ-WAIT","lane":"devin","unmet":["RQ-UPSTREAM"]}] …
```

Restock measures lane demand from distinct valid ready rows with nonempty prompts,
not the previous dispatcher status count. Parked, invalid, empty and duplicate
rows do not fill a lane. Its JSON output reports `queue_diagnostics` and
`parked_diagnostics` counts; parked rows with missing gates, invalid fields,
unmerged dependencies or duplicate job IDs remain in place for inspection.
A merged dependency releases at most one row per job, preserving its prompt.
These diagnostics do not modify or delete invalid rows. Restock source changes
require Security re-pinning before host installation.

Restock also cuts NOOP churn (RQ-PSEL-4-NOOPCUT): within one pass it keeps a
single line per target PR and per `file=` target, and it parks a job for 24 h
once its last 2 runs both retired as `DONE-NOOP` (skip reason `noop-streak`).
The streak lives in `queue/noop-streak.json`; a pass that really queues the job
clears it, `--dry-run` never writes it, and an unreadable file suppresses nothing.

`install.sh` installs the restocker and shared module alongside dispatchd.

### Local job wall cap

`local_job.py` supervises dispatcher-launched `codex-local` jobs with a fixed
2400 second wall cap covering preparation and agent execution. At the deadline
it kills the launcher process group, records exit 124 and a `finish` row with
`reason: timeout`, `wall_s` and `wall_cap_s`. The dispatcher avoids recording a
second finish when it later reaps that job. Other lanes retain their launcher.
The existing Security review and dispatcher pin procedure applies before host
installation. Do not install these files into the live directory from an agent.

This supervisor does not change the host-owned `launch.sh`, sandbox profiles,
worktrees, dependencies or model server configuration. Detached child sessions
cannot be killed by a process-group deadline. Readiness and warm reuse still
require the host launcher's source and its sandbox review: emit readiness only
after worktree preparation and an observed first model token, with the model
endpoint restricted to loopback. A health GET alone is not readiness evidence.
No production launch-to-ready or post-merge waste result is available locally.

## Bounded process ownership inspection

The dispatcher first lists process IDs and executable names, then reads arguments only for potential engine and shell owners. This avoids a Mac kernel stall while reading unrelated applications' arguments. Both inspection and cleanup have deadlines; a task stuck in uninterruptible sleep cannot hold the controller lock indefinitely.

If a live worker cannot be identified, the tick records `queue/process-snapshot.json` with `known: false` and exits before reaping or claiming any work. A missing argument row counts as an exit only when the OS confirms the process is gone. This preserves active jobs instead of treating an incomplete snapshot as an empty fleet. The installer copies `process_snapshot.py` before its dispatcher consumer.


# Existing PR and worktree recovery helpers

These Bash 3.2 helpers integrate with the operator's external bridge scripts.
The host launcher remains external; `publish.sh` is its reviewable publisher mirror. They need Git and an existing
Locus-authorized `gh` context, with credentials supplied through Phantom Secrets
when needed. They do not acquire tokens, switch accounts, push, or merge.

## Two hook lines

Set `PHANTOM_ROOT` to this checkout. Replace the existing PR creation in
`publish.sh` and worktree creation in `launch.sh`, respectively, with:

```bash
bash "$PHANTOM_ROOT/contrib/mac/pr-create.sh" "$repo" "$fork:$branch" "$base" "$title" "$body_file" || exit $?
bash "$PHANTOM_ROOT/contrib/mac/worktree-add.sh" "$repo_dir" "$job" "$worktree" "$start_ref" || exit $?
```

Map these variable names to the bridge's existing values. `repo` is the bare
repository name (for example, `phantom`) under `ashlrai`; `fork` is the head
owner login; `branch` is the already-pushed head branch. Pass an explicit base,
title, and readable body file. The PR helper prints only the created or reused
PR URL to stdout. Diagnostics go to stderr, without replaying raw CLI errors.
Retain the publisher's existing push, validation and approval gates around this
replacement. A successful URL does not establish CI or mergeability.

The PR helper first runs `gh pr list --head fork:branch`. Because
[gh documents qualified heads as unsupported](https://cli.github.com/manual/gh_pr_list),
an empty or failed lookup is checked with REST GET using the exact head and base.
Lookup failures stop creation. Existing open PRs are reused, including after an
ambiguous create failure. Only HTTP 5xx or GraphQL timeout errors retry
`gh pr create`, for three total attempts, with 2s and 4s backoff. After those
failures it checks again, then makes one REST POST to
`/repos/ashlrai/<repo>/pulls` through `gh api`, preserving title and body.
Permanent errors stop; a failed POST is reconciled with a lookup, never repeated.
Concurrent publishers can still race between lookup and creation; GitHub's
duplicate-head rejection is reconciled by the same lookup.

`job` is a single branch component; the launch helper creates
`codex-bridge/<job>` at `start_ref` (for example, `origin/main`). If normal
`git worktree add -b` fails specifically because that branch exists, the helper
checks NUL-delimited worktree porcelain records. Only an unused branch may be
reset with `-B`. Any registered worktree, including locked or missing paths,
blocks reuse. Recovery also refuses an existing destination, even an empty
directory: older Git can reset `-B` before reporting an occupied path. Nothing
is pruned and `--force` is never used. Recovery reserves the destination with
`mkdir` before `-B`, so its parent must already exist and be writable. If Git
subsequently fails, only that empty directory is removed; inspect any partial
worktree and the branch tip before retrying. An unused stale
branch's tip is intentionally reset to `start_ref`; retain valuable commits
elsewhere before relaunching that job. Paths can contain spaces or newlines.

## Local verification

```bash
bridge_test_home=$(mktemp -d)
HOME="$bridge_test_home" node --test contrib/mac/bridge.test.mjs
```

The tests use fake `gh` and `sleep` executables and disposable Git repositories.
They never contact GitHub or use the operator's credentials. The helper scripts
are invoked with `bash`, so no installation or executable-bit change is needed.


## Reconciling an already-integrated original PR

The host-owned `publish.sh <job> --integrated-merge` mode preserves a reviewed
two-parent merge on the existing `codex-bridge/<job>` fork branch. It reuses the
original open PR and requests its ordinary required CI and merge queue. It does
not create a replacement PR. Both modes reject staged symlinks named
`node_modules` before committing or pushing. A directory-only ignore rule does
not exclude such a link; regular checked-in dependency fixtures remain allowed.
An unavailable Git index also fails this check.

For an existing PR repair, the operator must explicitly disable any previous
auto-merge request before the first push and verify that readback. Merely leaving
auto-merge disabled in the new publication command does not clear an older
request. Restore normal queue admission after verifying the exact reviewed head.

Use this only when reconciliation establishes that every original contribution
is already present in current main. A final tree equal to main is necessary,
but does not by itself establish that contributions were retained. The operator
records per-path original changes, concrete main-source evidence and verification
for every path changed between the original head and its merge base with main.
Ambiguous or missing functionality must be repaired through the normal publisher.

`integrated-merge.py` validates a short-lived, private operator receipt under
`~/.ashlr-runs/integrated-merge/<job>.json`, bound by SHA-256 to the corresponding
`evidence/<job>.json` reconciliation record. Both directories must be owned by the
operator with mode700, and proof files must be regular, single-link mode600 files.
The receipt pins schema1, job, repository, original PR number, original head,
current main head, authored merge head, reviewed tree, creation/expiry times
and evidence digest. Its lifetime cannot exceed30 minutes. The merge must have
exactly the original head followed by current main as parents, and its committed
and indexed trees must exactly equal reviewed current main. Extra worktree
changes, links, stale records, missing path evidence and new deltas are refused.

The existing publisher retains its Git-safe, G1, protected-path, secret-shape and
fork checks. The helper uses the same pinned Git-safe implementation and literal
GitHub.com upstream/fork identities. Before the ordinary non-force fork push, it
rechecks the exact original PR state, owner/ref/head and current default-branch
head. Probe timeouts stop only their freshly created process group, with bounded
cleanup even when a grandchild retains stdout; unrelated workers are never signaled.
A per-job publication claim prevents concurrent use; successful push
consumes the receipt. A failure after push is reconciled against the existing PR,
without resubmitting a new branch or inventing changes. No tag/default-branch
push, CI override or protection bypass is introduced.

The reviewable publisher mirror and helper are host-installed together only
after independent review and digest pinning; neither is copied by `install.sh`.
The host publisher pins its helper digest. Preserve the previous host publisher
for rollback and inspect any partial push before retrying.

```sh
python3 -m unittest contrib/mac/tests/test_integrated_merge.py -v
python3 -m unittest contrib/mac/tests/test_publish_dependency_links.py -v
bash -n contrib/mac/publish.sh
```


## Host and session resource observations

The fixed `host_session_tick.py` composes `host_session_runtime.py`,
`host_session_observation.py` and `host_session_disk_cache.py`. The existing
controller invokes it under its existing `dispatchd.lock`; there is no new
service. Its fixed observation file is descriptive, not a quota, identity,
permission, or capacity grant. CPU is the OS-reported per-core average; RSS
sums shared resident pages and is not unique physical RAM. Disk is historical
allocated worktree attribution excluding `node_modules`, never free or
reclaimable capacity. Census, disk and UI freshness are independent.

The launcher registers the actual just-launched child with PID birth, current
boot and protected dispatch-record pins. Registration failure does not undo or
kill a launched process. The private claim-directory lock serializes only
registration and retirement. Each tick examines at most 512 current claims;
archived history is excluded from the active 256-row budget. A current root
must be absent in both complete fresh process censuses before retirement, with
unchanged protected input/name pins and a matching recorded attempt, terminal
exit receipt, or complete reaped-record absence. Reused PIDs, incomplete
observations, changed records and legacy claims lacking registration pins stay
unknown and are not retired. Archival does not prove provider quiescence or
make an empty inventory healthy. It grants no launch or reclamation authority.

`host_pressure_admission.py` reuses the bounded kernel observer. The surgical
host patches check pressure before selection and again immediately before
unreserved native Codex/Devin execution. On macOS only known-normal pressure
permits new work; non-Darwin behavior is retained. A late hold uses the existing
launch grace/requeue path, including reuse of its prepared worktree; retired
jobs remain cancelled. No worker is stopped, no percentage reserve or new
concurrency cap is added. Seven paced-lane final reservation/cancellation
integration and the separate product machine producer are outside this patch.

The existing whole `install.sh` is not the adoption transaction for these
current-host patches. Immutable helper closure, exact current-input comparison,
existing controller/ready locks, backups and post-adoption checks must be
reviewed separately. Source tests and a synthetic locked-tick measurement do
not by themselves establish live adoption or worst-case host latency.


## Host release observer source

`release-autorun.sh` is the reviewable source mirror for the existing
`ai.ashlr.release-autorun` LaunchAgent and fixed stock signing wrapper. It
selects immutable proof using the existing `gh` authentication; it
does not create credentials, version PRs, tags, qualification runs or npm
dispatches. The unchanged stock signer independently verifies the selected
source, run attempts, original artifacts, audit and signing/publication guards.
Selection metadata is not a reusable qualification grant.

The observer considers at most 20 newest successful attestors on current master.
A missing handoff does not hide an older ready attestor or create new permanent
seen state. Complete bounded artifact inventories must contain one exact
current-attempt handoff and build with matching run, source and repository.
Every completed per-source rc remains final. A started record without a
completion is uncertain and blocks before network or signing; no automatic
replay or legacy-state migration occurs. Existing seen records are preserved.

rev2 adds a post-selection update-channel pass. When no candidate needs signing
on a tick, each completed successful signing outcome (`sha-<sha>.rc` = 0)
without a `feed-<sha>.rc` marker gets a bounded published-state proof through
the same GET-only `gh` reads plus one unauthenticated public download:

- the tag's public release must be non-draft, non-prerelease and target the
  signed sha (`releases/tags/<tag>`; drafts answer 404 and stay pending);
- its asset inventory must be exactly the seven signed desktop artifacts —
  `Phantom_<v>_aarch64.app.tar.gz` + `.sig`, `ashlr-phantom-<v>.tgz` + `.sig`,
  `manifest.json` + `.sig` and `latest.json` — all `uploaded` with populated
  `sha256:` digests (still-populating digests stay pending);
- the four small signed bodies are fetched through `gh api` with
  `Accept: application/octet-stream` and byte-hashed against the recorded
  digests; `latest.json` must bind `platforms["darwin-aarch64"].url` and
  `.signature` to the tag's app asset and `.sig` bytes, and its `phantom`
  envelope must carry the exact `manifest.json` text and `manifest.json.sig`
  bytes, whose fields must bind the source sha and both artifact digests;
- while that release is `releases/latest`, the configured public endpoint
  `releases/latest/download/latest.json` must answer HTTP 200 with the same
  feed bytes (followed redirects, 15 s cap).

`feed-<sha>.rc` outcomes are final once written: `0` verified-live (receipt
`feed-<sha>.json`), `21` verified-but-superseded (a newer published release is
latest; no operator action), `22` inconsistent (receipt plus
`NEEDS-MASON-<tag>-feed`; `rm` the rc to allow one manual recheck). Pending
states — release absent, digests still populating, endpoint not serving — are
re-read each tick and never write markers. This pass never signs, publishes,
mutates a release or touches the keychain; signature-level minisign
verification stays with the consumer/finalizer path. See
[the update channel](../../docs/DESKTOP-UPDATE-CHANNEL.md).

`RELEASE_AUTORUN_OFF`, the existing observer/signer locks and keychain gate remain
unchanged. `install.sh` intentionally does not install this observer. Adoption
requires review of the exact merged source and current host input, an unchanged
owned OFF marker, private backup/journal, existing observer exclusion, a
single-file compare-and-swap replacement and readback. It must not overwrite
legacy outcomes or replace/restart launchd, the dispatcher, signer, keys or
other host controls. Clearing OFF is a separate explicit operator action.

The original rev1 input is retained only as an inert counterfactual fixture.
The following tests use fake GET-only GitHub and fake Bash signing processes
inside private temporary roots; they never contact a real publisher or keychain:

```sh
python3 -I contrib/mac/tests/test_release_autorun.py
bash -n contrib/mac/release-autorun.sh
```

## Recut feed

Preview conflict recuts with one command from the repository root:

```sh
python3 contrib/mac/recut-feed.py --dry-run
```

The JSON report (`schemaVersion`, `dryRun`, `count`, `lines`) lists at most six
READY jobs, oldest PR first, across the seven fleet repositories. It copies
the wording and attributes of the queue’s `RQ-RC3401N9Q8` reference line,
changing only the repository, PR number and job ID. A missing reference stops
the run without writing. Only open PRs
whose public REST detail says `mergeable_state=dirty` qualify. Unknown states
wait for the next run. No credentials are used; an API error stops the run.
READY and CLAIMED references in the queue and Supersedes links in open PR bodies
or queue notes suppress duplicates. Job IDs are stable across runs.
Replace `--dry-run` with `--apply` to append; use `--max N` to change the cap.
Apply rechecks the queue under the existing `ready.lock`, waiting at most ten
seconds (`--lock-timeout` overrides). `--queue PATH` selects a scratch queue;
the default is `~/.ashlr-runs/queue/router-queue.md`. The queue must already exist.
This supplies jobs only; it does not recut, merge, install, or publish anything.

### Disk growth

Run `python3 contrib/mac/disk-growth.py --json` periodically to sample free disk
space and directory sizes. `--budget-seconds` bounds the total time spent in
`du` (default 10 seconds). The sampler retains 48 readings under
`~/.ashlr-runs/queue`; it does not delete sampled files. The dispatcher copies
its latest report to `autopilot.disk` in `status.json` on the next tick. Install
and schedule the sampler through the normal reviewed host machinery; this source
change does not install it. Rates compare against the oldest retained reading;
missing or timed-out directory measurements are omitted, and a null projection
means there is not yet evidence of a positive disk burn rate. Directory sizes
overlap: worktree totals include their `node_modules` and `target` directories.
