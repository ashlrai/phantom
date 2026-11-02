# Driver operator runbook

## Availability and operating boundary

`phm drive` is registered in `src/cli/index.ts` and backed by a loaded
implementation. This runbook documents the operating procedure and commissioning
gates. The implemented supervisor contract, CLI flags, host bridge integration
and launchd template are in [Drive and host bridge integration](DRIVE.md).
Refer to that guide for exact flag syntax, defaults and bridge path semantics;
this runbook focuses on operational boundaries, pool policy and recovery.

The existing daemon, resource pools and Leader are separate systems. Their
status does not prove a driver is healthy. See [Architecture](ARCHITECTURE.md),
[resource pools](RESOURCE-POOLS.md) and the
[source agent operations guide](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-OPERATIONS.md#stop-and-pause)
for implemented controls. Driver operation must retain enrollment, authority,
quota, sandbox, review and protected merge gates. A successful job does not
by itself authorize publication or establish acceptance.

## Start and stop

Before the first start, record the installed revision, owner, dispatch scope,
approved budget, existing scheduler, state directory, memguard sentinel path,
pool limits and recovery contact. Obtain paths and supported options from the
landed implementation and its help, rather than guessing a home directory path.
Commission with fixture work before permitting real dispatch or provider costs.

| Action | Procedure |
| --- | --- |
| Start | `phm drive`. Check help and authority first. See [Drive and host bridge integration](DRIVE.md) for flags, bridge path defaults and publisher. Start one instance for the chosen state directory and scope. Verify fresh state and one owned fixture job before enabling more capacity. |
| Pause admissions | Create the memguard `PAUSE` file at the documented path (`--pause-file`; default `~/.ashlr-runs/PAUSE`). Verify admissions cease; record whether running jobs drain or are interrupted. |
| Stop | `phm drive stop` is available. It stops admissions, reconciles running work and reports quiescence before another scheduler takes ownership. See [Drive and host bridge integration](DRIVE.md) for shutdown signal and timeout details. |
| Inspect | `phm drive --once --dry-run` returns a plan without acquiring ownership. See [Drive and host bridge integration](DRIVE.md) for the normalized CLI report schema with version, timestamp, pool counts and admission state. |

Do not infer that closing a terminal stops child work, that deleting a PID file
releases ownership, or that a process exit proves all jobs stopped. Before a
restart, verify the old controller and its children are quiescent and reconcile
any external sessions. If graceful shutdown fails, use the recovery procedure
below and the implementation's documented supervisor controls. No supervisor or
signal recipe is established in this checkout.

## Memguard PAUSE file

The driver checks the memguard `PAUSE` sentinel before admission,
including immediately before launch. The sentinel is an admission hold, not
proof that active workers were terminated and not a substitute for global Stop.
The default convention is `~/.ashlr-runs/PAUSE`, configurable with
`--pause-file`. Unreadable control files and dangling symlinks hold admission.
The bridge must independently check the actual host controls inside its
admission transaction; the CLI check cannot close that race by itself. See
[Drive and host bridge integration](DRIVE.md) for the PAUSE contract and
launch hold semantics.

On a pause, record the cause and time, inspect memory pressure and running jobs,
and reduce concurrency or drain work. Leave a memguard-owned sentinel in place
while pressure persists. Establish who owns removal and whether memguard will
recreate it before clearing it. Resume only after pressure is healthy, ownership
is reconciled and limits are safe. Verify a fresh status and a single admission
before widening capacity. Do not clear unrelated daemon pause or global Stop
markers to resolve a driver pause. Exact path, file format, thresholds, polling
latency and automatic resume policy remain implementation prerequisites.

## Pool floors and ceilings

**Planned policy:** a pool floor is a desired minimum of useful concurrent work
when eligible tasks and safe capacity exist. A ceiling is a hard admission cap.
Neither reserves provider capacity nor authorizes spending. Define the unit
explicitly: running jobs, available seats and tokens are different quantities.

Record each pool's floor, ceiling, active count, eligible queue depth, account
scope and budget. Require nonnegative integer limits with floor no greater than
ceiling. Use a zero ceiling to disable admissions only after that behavior has
been implemented and tested. No configuration keys or numeric defaults are
established here.

Memory holds, Stop, authority, quota and account availability take precedence
over a floor. Never launch duplicate or ineligible work merely to meet a floor.
Count recovered and externally running jobs against the ceiling before filling
new slots. Lowering a ceiling below active work should hold new admissions;
termination policy must be explicit. Raise one pool at a time and observe
memory, queue age, failure rate and accepted outcomes before raising another.

## Reading status.json and jobs.jsonl

**Planned artifacts:** these filenames are intended driver observations, not
existing files with a stable schema. Do not confuse similarly named files from
other subsystems with driver evidence. Implementation must document the state
directory, schema version, atomic snapshot behavior, event durability and
retention before cutover. Never copy raw logs into public reports without
checking for private task content or credentials.

| Artifact | Evidence required before it can support operation |
| --- | --- |
| `status.json` | Schema/revision, controller identity, last update time, admission state and pause reason, per-pool limits/counts, and running job identities. Check freshness against the documented heartbeat interval and controller liveness. A readable stale snapshot is not health. |
| `jobs.jsonl` | One JSON event per line with stable job and attempt identities, pool, event time, transition, outcome and evidence references. Correlate launch, progress and terminal events by identity; count attempts separately from accepted tasks. |

These are required meanings, not field names or sample payloads. Do not build
queries against invented keys. Compare snapshot counts with event history and
actual worker sessions. Missing events, an incomplete final line, invalid JSON,
unknown versions or conflicting terminal outcomes require reconciliation, not a
healthy verdict. Preserve original files and capture a diagnostic copy before
repair. Never truncate the journal, forge a completion or edit a snapshot to
make a job disappear. Any eventual parser must distinguish a partial final write
from corrupt earlier records.

## Recovery from a stuck job

1. Hold admissions using the documented driver pause control once implemented.
   Record the job and attempt IDs, pool, controller, worktree, external session,
   last heartbeat, last progress and timeout policy. Preserve state and logs.
2. Distinguish slow work from a dead controller, a disconnected provider or an
   approval wait. Compare journal events, snapshot freshness and actual worker
   liveness. Elapsed time alone does not prove failure.
3. Request cancellation through the owning runtime's documented control. Verify
   the worker and any external session stopped. If cancellation is uncertain,
   keep the job quarantined and capacity occupied; do not launch a replacement.
4. Inspect the worktree and any existing proposal or PR. Preserve useful changes
   and evidence without committing, publishing or deleting operator data as a
   recovery shortcut. Reconcile external effects before retrying.
5. Use an implemented reconciliation path to record the terminal disposition.
   **Planned:** driver retry and reconciliation commands have no CLI syntax in
   this checkout. Do not hand-edit the journal or invent a retry invocation.
6. After confirmed termination, retry only with explicit attempt identity and
   duplicate-effect checks. Validate one recovered job, ceiling accounting and
   fresh observations before releasing the admission hold.

Escalate unresolved ownership, corrupt state, unconfirmed cancellation or repeated
failures to the operator with evidence. Keep admissions held for the affected
scope. A controller restart must not silently requeue every apparently running
job.

## Parallel run, then cutover

**Planned rollout:** parallel observation must not mean two schedulers dispatch
the same tasks or share one writable state directory.

1. Inventory the incumbent scheduler, queue claims, in-flight work, account
   limits and stop procedure. Name a cutover owner and rollback conditions.
2. Run the driver in a future implemented observation-only mode against recorded
   inputs or fixtures. No shadow-mode flag exists yet. Compare proposed routing,
   pool counts, pause behavior and stuck-job detection with incumbent decisions.
3. If live parallel validation is authorized, partition tasks and account
   capacity explicitly, use separate state directories and enforce exclusive
   claims. Account for the combined ceiling and budget across both schedulers.
   Otherwise keep the driver observation-only until cutover.
4. Require tested Stop/pause, restart reconciliation, ceiling enforcement,
   durable events, stale-status detection and cancellation before cutover.
   Capture fixture results and an agreed observation window with no duplicate
   dispatch or unexplained state differences.
5. Hold new admissions on both sides, drain or explicitly reconcile incumbent
   jobs, and verify no ambiguous claims remain. Transfer ownership once. Start
   the driver at a small approved ceiling and verify one complete job with
   independent acceptance evidence before widening capacity.
6. Roll back for duplicate claims, ignored holds, unsafe memory pressure,
   unexplained accounting or lost observations. Hold driver admissions, reconcile
   its active work, then restore incumbent ownership only after exclusivity is
   established. Retain both evidence histories for review.

Do not disable required CI, review or merge protections for cutover. The external
router's `publish.sh` handoff is outside this driver interface and is not present
in this checkout; it is not a driver command or a package release instruction.

## Cloud task error forwarding

**Planned contract:** cloud tasks (branch namespace `ashlr-cloud/`) deliver work
through the existing PR triage path. When the budget API, activity API, or the
worker session returns structured 503 errors with `{ code, error }` bodies, the
driver must forward them into the task report rather than swallowing them into a
generic failure. Web consumers (`BudgetControl`, `useActivity`) already surface
`ApiError.detail`: the driver should route the same structured detail through the
task's `report.risks` and `stateReason` fields so the operator can distinguish a
capacity hold from a true worker fault.

When a cloud task branch push fails with a remote refusal (protected branch,
missing credentials, or a conflicting ref), the driver must record the refusal
as a terminal disposition rather than retrying blindly. The branch name format
`ashlr-cloud/<taskId>` is the authority for the task-to-branch mapping; never
rewrite it or push to the task's `baseBranch`. The existing `pr-actions.ts`
land/close/update-branch path handles the branch after the driver launches the
worker; the driver's responsibility ends at publication.
