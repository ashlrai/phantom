# Mac queue lane scripts (repo copies)

`restock.py` and `dispatchd.py` are reviewable repository copies of the
deterministic Mac queue scripts that run under `~/.ashlr-runs` on the dispatch
host. `dispatchd.py` here is the single source for the live dispatcher (see
[Installing the dispatcher](#installing-the-dispatcher)). They are pinned artifacts: changes
land by PR review, and Security re-pins the sha before any live install. Both
are deterministic (no model or network calls of their own) and neither creates
tokens.

`restock.py` claims eligible `READY` lines from `router-queue.md` into lane
prompts (`ready.tsv`/`claimed.tsv`) for the fleet allowlist repos only, keeping
the READY stock at >=30% `bet=bold` and parking security-pinned surfaces as
`HOLD-SECURITY`. `dispatchd.py` is the per-tick supervisor: it reaps finished
jobs, adapts per-lane slot targets inside `slots.json`, launches queued lines,
and fires the restocker when a lane's queue runs shallow.

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
also capped fleet-wide at `min(sum of unheld lane targets, ncpu, hard_cap)`. Every
pool has a `hard_cap` in `slots.json` and so does the file itself (top-level
`hard_cap`, default 18); the stored floor, ceiling and target are clamped to it
every tick, immediately after the autopilot's `budget-overrides.json` floor and
ceiling are reapplied, so neither the overrides nor the ramp can lift a pool
past its `hard_cap`. dispatchd writes `queue/admission.json` (also embedded in
`status.json`) and logs `LOADGATE tripped|clear` once per change. `phm pool
admission --json` reports the same verdict read-only. `queue/LOADGATE_OFF` is the
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

## Queue wait and claim fairness

The dispatcher writes `enqueue` on first observation of a ready job, including
while admission is paused or its lane is held. `queue/run/<job>.enqueued`
receipts prevent duplicate enqueue events across ticks. `claim` is written after
precheck and admission succeed, immediately before spawning the launcher. Both
records carry `job`, `repo`, `lane`, `tier` and the event timestamp `ts`.
Pair enqueue and claim by job to measure observed queue wait; prompt creation
and launch are separate phases. Observation starts at the dispatcher snapshot,
so time between a writer appending and the next snapshot is not measured.
Requeues of the same job retain their original enqueue observation.

`queue/claim-cursor.json` remembers the last successfully spawned lane. The next
tick starts round-robin after that lane, so backlogged early lanes cannot consume
every tick's claim limit indefinitely. Held lanes and blocked jobs are still
skipped, and all admission, disk, local health and capacity checks still apply.

## Installing the dispatcher

`install.sh` diffs `dispatchd.py`, `install-gate.py` and `launch-gate.sh` against
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

Copy `wt-prune.sh` and `wt-prune.py` together to the bridge directory, then run
`wt-prune.sh --dry-run` before enabling cleanup. At the existing `WT_REMOVED`
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

Restock and dispatch share `launch_precheck.py`: precheck exit codes 10–13
retire a line as `DONE-NOOP` before restock writes a prompt, claim, or
`ready.tsv` entry. Errors and timeouts keep the existing fail-open behavior;
dispatch checks again at launch. Preview without changing queue files:

```sh
python3 contrib/mac/restock.py --dry-run --json
# {"dry_run": true, "queued": 0, "done_noop": ["RQ-EXAMPLE"], "skips": {"done-noop": 1}}
```

Restock also cuts NOOP churn (RQ-PSEL-4-NOOPCUT): within one pass it keeps a
single line per target PR and per `file=` target, and it parks a job for 24 h
once its last 2 runs both retired as `DONE-NOOP` (skip reason `noop-streak`).
The streak lives in `queue/noop-streak.json`; a pass that really queues the job
clears it, `--dry-run` never writes it, and an unreadable file suppresses nothing.

`install.sh` installs the restocker and shared module alongside dispatchd.
