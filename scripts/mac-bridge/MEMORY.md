# Mac heavy-step memory admission

`memory_admission.py` provides a shared FIFO queue for trusted local build and
test commands. `with-memory.sh` adds command shims to an existing bridge launch.
This source change does not install or activate the adapter. The installed
bridge launcher and memguard configuration were unavailable for inspection;
Phantom's protected router and publish configuration remain untouched.

## Bridge integration

After review, place `memory_admission.py` and `with-memory.sh` together in the
operator's trusted bridge tools directory, executable by the operator. Keep
Python 3.9+ available on its trusted PATH. Invoke the existing launcher through
the adapter, retaining its usual arguments and stdin prompt:

```bash
/path/to/with-memory.sh --job JOB -- /path/to/launch.sh JOB phantom codex-cmp frontier < JOB.prompt
```

Every launcher and heavy step on the host must use the same state directory.
The default is `/tmp/phantom-memory-<uid>`: changing HOME for hermetic tests does
not create another semaphore. `--state-dir` or `PHANTOM_MEMORY_STATE_DIR` selects
an explicit shared directory. A custom directory must be private, owned by the
current user, and accessible from every participating worktree and sandbox.

The default pause sentinel is the account's home directory from the OS account
database plus `.ashlr-runs/PAUSE`, also independent of HOME. This is a convention,
not a verified installed memguard path. Set `PHANTOM_MEMORY_PAUSE_FILE` or
`--pause-file` to memguard's actual sentinel before activating the adapter.
Any sentinel, including a dangling symlink, pauses admission. Unreadable pause
state or telemetry queues work instead of treating it as safe to run.

Sandboxed jobs need permitted access to the trusted Python module, shared state,
pause sentinel, numeric `ps` fields, and Mac memory telemetry commands. Confirm
those permissions through the existing sandbox approval process; this adapter
does not change sandbox policy. An inaccessible default pause directory will
keep work queued. Verify the gate inside the actual bridge sandbox before
production activation.

The adapter intercepts PATH-based `cargo`, `npm`, `npx`, and `tsc`. It classifies
Cargo build/test/check/clippy/bench/rustc, npm test/build/lint/typecheck families,
and npx tsc/vitest as heavy. Lightweight commands execute normally. Absolute
executable paths, a replaced PATH, and other package managers require explicit
wrapping. The launcher must preserve the adapter's PATH and gate settings.

```bash
python3 memory_admission.py run --job JOB --profile cargo-test -- cargo test --lib
python3 memory_admission.py run --job JOB --profile tsc --reserve-gib 6 -- npm run typecheck
python3 memory_admission.py status
```

## Admission and recovery

- At most four heavy reservations are active for the shared state directory.
- Admission requires at least 30% free RAM **after** subtracting every active
  reservation and the new request. macOS free RAM counts free and speculative
  pages; inactive, purgeable, and compressed pages do not increase the budget.
- Swap at or above 8 GiB blocks new admission. PAUSE blocks new admission and
  leaves active work to finish; memguard retains its own running-job controls.
- Each step reserves 4 GiB by default, or its explicitly requested amount,
  raised to at least 125% of the largest recorded peak for its profile. Live
  sampled growth can increase an active reservation. Existing RSS is deliberately
  counted again in reservations to leave headroom for growth between samples.
- Kernel locks serialize admission and hold leases. FIFO ordering uses a
  serialized sequence, not wall-clock timestamps. There is no TTL takeover.
  A crashed wrapper's reservation remains while its process group is alive.
  The launch handshake records that group before the workload starts.

Do not delete lock files or reset the state directory while jobs are running.
Missing or malformed coordination data blocks admission. Investigate a persistent
`queued (telemetry-unavailable)` diagnostic before repairing state. A profile's
historical peak can legitimately be too large for the currently available RAM.

Nested npm/tsc commands reuse an active inherited lease or the recorded process
group, avoiding a second slot and nested queue deadlock. A token alone does not
authorize reuse by another group. Heavy children receive `CARGO_BUILD_JOBS=4`.
SIGINT, SIGTERM, and SIGHUP cancel queued work or terminate the active group,
with a five-second grace period before SIGKILL. Child exit codes are preserved.
Waiting has no default deadline. Explicit `run --wait-seconds N` returns 75 on
queue timeout; its caller must resubmit if it wants to keep that job queued.

## Measurements and limits

Private `receipts/*.json` files record job/profile, timing, admission telemetry,
exit status, and peak RSS; `peaks.json` supplies conservative profile history.
No command arguments, environments, or credentials are persisted by the gate.
Child stdout/stderr continue to their original destinations.

RSS sampling uses only `pid,ppid,pgid,rss,stat` from `ps`, never command text or
environments. `sampledGroupPeakBytes` is the largest observed simultaneous sum
for the workload's process group. `childHighWaterBytes` is the kernel child
high-water mark, which covers short children but is not a simultaneous tree sum.
`peakRssBytes` takes the larger figure. Sampling errors are recorded.
If process telemetry disappears after launch, only an explicit absent process
group from the kernel can release its slot; unknown liveness retains it.

This is admission control, not an OS memory limit. External applications,
unwrapped commands, unexpected memory spikes, and descendants that detach into
another process group can exceed the modeled budget. Do not use this wrapper
for daemonizing workloads. PAUSE cooperation and these measurements cannot
guarantee physical free RAM or swap against arbitrary workloads.

## Verification

Run the unit, process integration, and simulated batch checks with a temporary
HOME; no large memory allocation or provider call is needed:

```bash
memory_test_home=$(mktemp -d)
HOME="$memory_test_home" python3 scripts/mac-bridge/test_memory_admission.py -v
HOME="$memory_test_home" python3 scripts/mac-bridge/test_memory_processes.py -v
HOME="$memory_test_home" python3 scripts/mac-bridge/test_memory_admission.py --simulate
```

The 25-job simulation uses the real filesystem queue with deterministic Mac
telemetry: 32 GiB RAM, 18 GiB initially free, 2 GiB reservations, and 3 GiB swap.
It checks FIFO completion, PAUSE and swap waits, four active slots, and at least
30% modeled free RAM. Its result is not a physical Mac stress test or proof that
the installed bridge is integrated. Production acceptance additionally requires
the real sandbox/launcher path and live memory observations during a batch.
The separate process suite exercises 25 independent clients and actual adapter
routing. Its process-table observations are injected because the development
sandbox denies `ps`; its kernel child high-water readings and kernel locks are
real. This does not qualify the live process-table sampler in that sandbox.
