# Mac queue supervisor

`phm drive` runs serial ticks, with a 30 second delay after each completed tick.
It reaps finished workers, publishes successful jobs through the existing
`publish.sh`, and admits READY jobs within pool floors, ceilings and a global
ceiling. STARTING jobs consume capacity. Floors receive priority over surplus
work; floors do not create work or override admission. Job kinds bound which
pools may serve them, and a pool can be capped at a paced daily share — see
[Pool routing](#pool-routing).

```sh
phm drive --once --dry-run
phm drive --once --dry-run --bridge /absolute/path/drive-bridge
phm drive --tick 30 --bridge /absolute/path/drive-bridge --publisher /absolute/path/publish.sh
```

## Integration status

This change provides the supervisor, CLI, subprocess bridge protocol and fake
pool acceptance tests. It does **not** include the Mac-specific bridge executable.
DRIVER-1 and the #1014 admission implementation are absent from this checkout,
but their documented interfaces were inspected locally: DRIVER-1's uncommitted
`docs/QUEUE.md` and `src/core/queue/schema.ts` in the sibling
`RQ-PHANTOM-DRIVER-1-QUEUE` worktree, and `scripts/mac-bridge/MEMORY.md` at local
ref `codex-bridge/RQ-MAC-MEM-ADMISSION`, commit `74bbf659`. These dependency
interfaces inform the bridge contract below; they are not evidence of a merged
dependency or an installed host integration.

Reading `~/.ashlr-runs/queue/README.md` returned `Operation not permitted`.
The live dispatchd status/ledger schemas, actual pool runner and publisher
arguments, and shared scheduler ownership mechanism remain unqualified.

The executable bridge described below must be implemented against those host
contracts before live use. This is a new dependency seam, not a claim that
dispatchd already implements this protocol. A missing bridge fails closed.
Keep dispatchd as the active fallback until Masbot validates the bridge and
coordinates ownership transfer. This command never stops dispatchd, installs
a service, edits runner configuration or changes the sandbox.

The bridge path defaults to `~/.ashlr-runs/queue/drive-bridge`; the publisher
defaults to `~/.ashlr-runs/queue/publish.sh`. These are integration defaults,
not verified host paths. Override them with absolute canonical paths as needed.
Bridge and publisher must be owned regular executable files, with no symlink
aliases, hard links or group/world write permission. Only `publish.sh` is
accepted as the publisher basename.

## Tick behavior

1. Acquire exclusive shared dispatch ownership. A busy or unavailable owner
   returns a hold without reaping, publishing, launching or writing status.
2. Reap through the existing runner, recording durable completion evidence.
3. For each successful FINISHED job, reserve publication durably, invoke
   `phantom exec -- /absolute/path/publish.sh <bridge-supplied arguments>`,
   then record its outcome. No direct Git or GitHub push exists in the driver.
4. Read current queue and capacity. Fill below-floor pools first, then remaining
   capacity by descending priority and queue order. Re-read before every launch.
5. Recheck PAUSE and ask the bridge to atomically verify READY, completed
   dependencies, claim ownership and capacity before launching the existing
   runner with #1014 heavy-step admission wired into its commands.
6. Write native status through the bridge and release ownership in `finally`.

Memory PAUSE blocks launch but permits reap and completion publication. The
default PAUSE convention is `~/.ashlr-runs/PAUSE`, configurable with
`--pause-file`. The driver also treats `~/.ashlr/KILL` as a launch hold.
Unreadable control files and dangling symlinks hold admission. The bridge must
independently check the actual host controls inside its admission transaction;
the CLI check cannot close that race by itself. Native authority and Stop rules
must also guard publication in the host adapter/publisher.

`--once --dry-run` calls only the bridge's read-only `snapshot` and reads control
file metadata. It does not acquire ownership, reap, reserve, publish, launch or
write status. Its plan uses currently known capacity; it does not assume reaping
will free slots. `--dry-run` alone also returns after one tick. Unknown admission,
malformed snapshots and unconfigured pools never become free capacity.

SIGINT/SIGTERM stop new actions and wake the interval sleep. An in-flight bridge
call or publication settles first, with a 120 second command timeout. The driver
does not kill fleet workers. Long-running mode reports a failed tick and retries
after the configured delay; one-shot failures return exit 1. Usage errors return
exit 2. Child stdout/stderr and publication arguments are never printed.

## Dependency integration requirements

### DRIVER-1 queue.v1

The inspected queue contract stores `schema: "queue.v1"` and a `jobs` array at
`~/.ashlr-runs/queue/queue.v1.json`. Queue states are
`READY|CLAIMED|PR-OPEN|BLOCKED|HOLD|DONE|PROPOSED`. They are distinct from the
execution states in this driver's normalized snapshot. The adapter must not
write STARTING or PUBLISHING into `queue.v1` as queue statuses; retain execution
and publication evidence in the host's corresponding records.

Only READY jobs whose dependencies all exist and are DONE may be presented as
launch candidates. Recheck that condition inside the queue claim transaction,
then retain the resulting active claim owner through execution and publication.
Missing dependencies, cyclic dependencies, HOLD, PROPOSED and BLOCKED never
become dispatchable automatically. Imported CLAIMED jobs without ownership
evidence must not be reclaimed or assigned invented owners. Unknown routing
fields such as `unspecified` require review before launch.

Use DRIVER-1's `read`, `claim` and `finish` store seam. Completion and blocking
must use the last active claim's owner. Recording a PR URL yields PR-OPEN and
retains the claim; recording DONE without a PR URL closes it. These are
operator-reported queue states, not proof of merge or required checks. A worker
exit or a publisher's successful invocation does not by itself authorize a
queue DONE transition. Preserve the queue's no-automatic-reclaim rule and never
steal `queue.v1.lock` by age or PID heuristics.

The structural helper
[`projectDriveQueueV1`](../src/core/drive/queue-v1.ts) accepts the documented
QueueDocument shape after the queue store validates it. It maps P0 through P9
to descending numeric priority, preserving P0 precedence and queue order for
ties. READY with incomplete dependencies, unknown priority or unspecified
routing becomes HELD. Imported CLAIMED conservatively becomes STARTING and
consumes capacity even when its owner is unknown. Other queue statuses become
HELD until the bridge overlays independently verified execution/publication
evidence. DONE and PR-OPEN alone never prove worker termination or publication
success. Merge the complete host worker inventory into this projection so no
active worker disappears from capacity accounting.

The helper does not claim jobs or replace the queue's runtime validator. Validate
its translation against the dependency schema before cutover. The queue
transaction lock is not a replacement for shared dispatchd ownership or for
memory admission.

### #1014 heavy-step memory admission

The inspected memory contract provides `with-memory.sh` and
`memory_admission.py`. Preserve the adapter's PATH and gate settings when
invoking the existing launcher. Its shims gate heavy PATH-based cargo, npm,
npx and tsc operations. Absolute executable paths, replaced PATH values and
other package managers need explicit heavy-step wrapping; they must not become
admission bypasses.

Gate each heavy build/test operation, not the whole `phm drive` daemon or the
lifetime of a daemonizing pool worker. Do not use `memory_admission.py run` to
hold a reservation around a daemonizing workload. Configure the existing runner
so its heavy child steps pass through the gate while its sandbox remains intact.
The driver snapshot's `admission` value is a readiness observation, not a heavy
reservation; each heavy step must acquire the real semaphore at execution time.
If the shared gate is absent, inaccessible or unqualified, hold new launches.

All participating worktrees and sandboxes must share the same gate state. The
documented default is `/tmp/phantom-memory-<uid>`, configurable through
`PHANTOM_MEMORY_STATE_DIR` or `--state-dir`, independent of HOME. The gate's
default PAUSE convention uses the OS account home plus `.ashlr-runs/PAUSE`, also
independent of HOME. Configure the driver's `--pause-file` and the gate's
`PHANTOM_MEMORY_PAUSE_FILE`/`--pause-file` to the same actual memguard sentinel;
the convention has not been verified against the installed memguard.

The gate admits at most four heavy reservations, requires at least 30% modeled
free RAM after reservations, and blocks admission when swap reaches 8 GiB or
PAUSE is present. Unknown telemetry queues work. Kernel locks and process-group
liveness retain uncertain reservations without TTL takeover. Never delete its
lock/state files, bypass admission, or relax sandbox access to make it run.
Host acceptance must verify the adapter inside the actual runner sandbox.

## Host bridge protocol: phm-drive/v1

Each invocation is an executable plus two literal arguments: an operation name
and one JSON request object. There is no shell interpolation. Requests include
`"protocol":"phm-drive/v1"`. Replies must be one JSON object of the form
`{"protocol":"phm-drive/v1","result":...}` on stdout. Private diagnostic
logging belongs to the bridge; stdout is bounded to 4 MiB. Do not return secrets,
environment dumps, prompts or auth material in any reply.

| Operation | Additional request fields | Result and required behavior |
| --- | --- | --- |
| `snapshot` | optional `lease` | Normalized snapshot below. Without a lease this must be strictly read-only. Present READY candidates only when every dependency is present and DONE. Include every active worker, including dispatchd and uncertain STARTING work. |
| `acquire` | none | An opaque 16-160 character `[A-Za-z0-9_-]` lease, or `null` when held. Must exclude dispatchd and all other driver instances using the real shared ownership mechanism. Never independently create a second scheduler lock. |
| `reap` | `lease` | `true` after idempotently reconciling completion evidence, updating queue state and appending native `jobs.jsonl` records. A missing PID alone is not completion evidence. |
| `launch` | `lease`, `job` | `"launched"` or `"held"`. Recheck shared ownership, pool/global counts and PAUSE; atomically claim READY with all dependencies DONE using the queue claim owner. Persist STARTING execution evidence before invoking the existing sandboxed runner with #1014 heavy-step gating. Do not reserve a heavy slot for the worker's entire lifetime. |
| `reserve-publish` | `lease`, `job` | `null` if not eligible; otherwise `{"argv":["literal","arguments"]}` after durably recording PUBLISHING. Use the existing publish.sh argument contract. |
| `finish-publish` | `lease`, `job`, `outcome` | `true` after durably recording `published` or `unknown` and its native ledger event. |
| `write-status` | `lease`, `report` | `true` after atomically writing `status.json` in the dispatchd format. Map the normalized report; never replace native schema with the CLI report. |
| `release` | `lease` | `true` after releasing only this owner's lease. Must not release a successor's ownership. |

All mutations must validate the lease, process identity and native authority
before effects. Admission and ownership must fail closed if #1014 or its state
is unavailable. Timeouts or lost replies must retain STARTING/PUBLISHING intent;
never retry a launch or publication just because its acknowledgement was lost.
Ownership recovery must account for in-flight workers and publishers before
transferring to dispatchd. The bridge must support leases across multiple
subprocess invocations, with safe renewal/recovery for long ticks.

The bridge invokes the existing pool runner with its current confinement and
Locus identity checks. Secrets-dependent execution uses `phantom exec --`.
No new credentials, access to `~/.codex` auth, sandbox overrides or non-loopback
local inference endpoints belong in this adapter. The supervisor itself makes
no inference calls and supplies no sandbox flags.

### Snapshot

```json
{
  "version": 1,
  "pools": [{ "id": "codex-cmp", "floor": 1, "ceiling": 2 }],
  "maxRunning": 2,
  "paused": false,
  "admission": "open",
  "jobs": [{ "id": "RQ-EXAMPLE", "pool": "codex-cmp", "state": "READY", "priority": 100 }]
}
```

`admission` is `open`, `closed` or `unknown`. Counts are nonnegative integers;
floors cannot exceed ceilings and their sum cannot exceed `maxRunning`. Job and
pool identifiers use ASCII letters, digits, dots, underscores and hyphens, start
with a letter or digit, and are at most 160 characters. Jobs have unique IDs and
must reference a configured pool. Priorities are safe integers; higher goes first.

States are READY, HELD, STARTING, RUNNING, FINISHED, FAILED, PUBLISHING, PUBLISHED
and PUBLISH_UNKNOWN. HELD is not launchable. FINISHED requires an integer
`exitCode`; only zero is eligible
for publication. A lost/failed publication becomes PUBLISH_UNKNOWN and requires
reconciliation against publish.sh evidence before another attempt. A driver
crash can leave PUBLISHING, which must receive the same reconciliation. Neither
state is selected automatically for publication. Do not infer success from a
worker exit when its completion artifact is missing.

### Pool routing

A job's kind is the uppercase token leading its id after an optional `RQ-`
prefix (`RQ-GEN-…` is GEN, `RQ-REFILL-…-LAND-…` is REFILL). Kind bounds which
pool may serve the line; the driver never re-pools a violating line — it stays
queued (HELD at the queue.v1 seam, never planned at launch) until routing is
corrected, because pool is spend attribution.

- `codex-personal` serves only LAND, FIXUP, DRAIN and DAILYFIX lines. Every
  other kind — including an id with no recognizable kind — is ineligible there.
- GEN, PLAN, SELFOPT and DESK lines go only to `devin` or `codex-local`.
- Kinds the rules do not name keep their declared pool (never
  `codex-personal`).

A pool row may carry an optional `daily` object — the pool's paced daily share
as the bridge reports it:

```json
{ "id": "codex-personal", "floor": 0, "ceiling": 2,
  "daily": { "share": 6, "used": 2, "startMs": 1770000000000, "endMs": 1770086400000 } }
```

`share` dispatches vest evenly across `[startMs, endMs)`; `used` is the
bridge-verified count already spent inside it. The pool launches only while
the vested allowance still exceeds `used`, so it can never be ahead of its
even pace for the day. A malformed `daily` invalidates the snapshot, and an
unstarted or stale window admits nothing — the bridge must present the fresh
window before the share re-opens. Pools without `daily` are unpaced: their
ceiling alone bounds them.

The normalized CLI report contains `version`, `at` (ISO timestamp), `dryRun`,
`paused`, `active`, `ready`, `planned`, `launched`, `published`,
`publicationUnknown` and `held`. This report is for human/machine CLI consumers;
the adapter translates it into the host status format. Native queue mutations
append `jobs.jsonl` through the existing store so dispatchd readers keep working.

## Launchd template for Masbot

This XML is documentation only. Masbot supplies absolute escaped paths and the
actual runtime PATH, validates host compatibility and installs the service after
ownership cutover. No `.plist` file or launchd installation is changed by this job.
Keep the service disabled until the adapter passes the host checks below.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.ashlr.phantom-drive</string>
  <key>Disabled</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/phm</string><string>drive</string>
    <string>--tick</string><string>30</string>
    <string>--bridge</string><string>/ABSOLUTE/PATH/drive-bridge</string>
    <string>--publisher</string><string>/ABSOLUTE/PATH/publish.sh</string>
    <string>--pause-file</string><string>/ABSOLUTE/PATH/PAUSE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/ABSOLUTE/PHANTOM/AND/NODE/BIN:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>150</integer>
  <key>StandardOutPath</key><string>/ABSOLUTE/PRIVATE/LOGS/drive.out.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PRIVATE/LOGS/drive.err.log</string>
</dict>
</plist>
```

Before cutover, test the adapter on copied/synthetic native state: native
status/jobs schema compatibility, shared ownership contention against dispatchd,
two drivers, semaphore denial, PAUSE racing a launch, crash recovery around
STARTING/PUBLISHING, publisher argument fidelity, and graceful shutdown. Compare
`phm drive --once --dry-run` with dispatchd's plan. Cutover and rollback must
transfer the same ownership fence; never run both schedulers independently.

Unit acceptance uses a fake pool runner and does not exercise a paid worker,
live publisher, real auth store or active fleet. Run it with an isolated HOME:

```sh
HOME=$(mktemp -d) npx vitest run test/drive-supervisor.test.ts test/drive-cli-bridge.test.ts
```
