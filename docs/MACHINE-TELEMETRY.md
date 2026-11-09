# Local machine telemetry

Enable `telemetry.machine.enabled = true` in Phantom configuration, then run
`phm resources sample --json`. Collection is disabled by default. Disabled
telemetry performs no collection or fleet writes. Help and invalid arguments do
not sample. Unknown flags, bind addresses and URLs are rejected. The command
updates only `resources.machine` in `~/.ashlr-runs/fleet.json` and prints the
observation. It uses bounded local files and fixed nonprivileged OS commands,
without network, shell commands, listeners, sudo or provider credentials.

The existing dispatch resource read invokes the same adapter even when provider
readings come from cache. An external queue must deliberately adopt this adapter;
this source change does not install or activate another controller or service.

## Queue controls and verified roots

Current `dispatchd.status.v1` has aggregate running counts, not PID rows. Only
that exact schema gives `paused: null` the meaning not paused; a nonempty reason
means paused, and malformed/missing state is unknown. The legacy PID-array
`running`/`jobs` parser and its memguard forms remain available for descriptive
compatibility: pause/paused or `{paused:true}` pauses, normal/run/running/resume
or `{paused:false}` clears, and missing/unrecognized state is unknown. Counts
and legacy PID labels do not prove current process ownership.

The default TS reader independently verifies current-user launchers with a cheap
numeric/comm census and targeted ownership inspection. It binds exact protected
`.line`, `.base`, `.dispatched` and optional per-job `.root-owner/owner.json`
metadata to a canonical physical worktree, source-tagged process start and the
current boot. Prompt paths may use any owned regular file inside the existing
queue prompt namespace; prompt contents are never read. Protected metadata and
coverage are checked again before returning. Unknown, changed, duplicated or
incompletely inspected roots remain unknown, never a fabricated empty fleet.
An actually complete healthy empty inspection can report known empty. Retained
run-directory history is enumerated completely, up to 65,536 entries within the
same five-second budget; only dispatch markers occupy the bounded root list.
Malformed current markers and enumeration exhaustion remain unknown.

Dispatcher aggregate running counts also include worktree/cwd sessions and
launch grace; a retained `.dispatched` or `.rc` alone does not establish liveness.
The conservative reader requires the inspected launchers, protected dispatch
witnesses and fresh aggregate coverage to agree. Direct sessions or retained
markers that cannot be reconciled therefore leave attribution unknown; this
reader does not infer their PID ownership or alter controller records.

Process-start `ps-lstart` is an observational second-resolution identity, not a
cryptographic execution witness or launch permission. All root output is bounded
metadata: job ID, PID, start/boot references and an ownership-binding digest.
No raw arguments, home/worktree paths, prompts, environment or credentials leave
the reader. Linux boot identity uses the kernel boot ID; Darwin uses the existing
boot-session/machine identity semantics. A five-second reader budget aborts owned
OS probes and returns unknown on an async dependency timeout; no worker is killed.
This is not a guarantee that an uninterruptible kernel filesystem call can be
cancelled. Metadata command probes have independent 1.5-second/output bounds.

## Measurements and attribution

Host CPU percentages use per-core counter deltas from a prior observation,
without sleeping; the first sample has null percentages. Load averages are OS
1-, 5- and 15-minute values. Process CPU is an OS-reported average with 100% equal
to one core; it is not the host counter interval. A numeric start-bearing `ps`
snapshot must match each verified root start before attributing its PPID tree.
Descendants outside the original process group are included. Overlapping root
trees become unknown rather than double-counting descendants. Reparented or
other unattributed processes are not silently claimed.

`processAttribution` reports observed/attributed/unattributed process counts,
OS-average CPU and process RSS from that same numeric census. Process RSS can
count shared pages repeatedly and is not unique physical host RAM. Its
unattributed RSS is a process-census remainder, never host used RAM minus fleet
RSS. Unknown root coverage leaves attribution/remainders unknown while
independent host RAM, CPU and disk observations remain available. Darwin
per-process swap remains unknown.

macOS RAM free is free plus speculative pages from `vm_stat`, with OS free-memory
fallback. Linux uses `MemAvailable` from `/proc/meminfo`; used RAM is total minus
available RAM. Disk free is reported for each local mounted volume. All memory,
swap and disk counters use bytes. Darwin pressure uses kernel pressure level,
`memory_pressure -Q` free percentage and `vm_stat` pageouts. Unprivileged
`powermetrics` may report GPU/ANE residency; denial or timeout yields null.
Linux optionally reads the primary DRM device's GPU busy counter; unsupported
accelerators remain null. Metric commands run concurrently with 100 ms bounds;
root verification has its separate bound. Actual total latency must be measured
under the dispatch host's workload before adoption.

## Advisory math and persistence

`advisoryHeadroom` preserves the historical calculation
`floor(freeBytes * 0.75 / estimatedJobRssBytes)`. The estimate is the larger of
1 GiB (or the configured positive estimate) and the largest measured job RSS.
Unknown roots, swap growth, paused/unknown guard, missing process measurements
or critical pressure yield zero advisory slots. `headroom` is null. This is not
a new 25% automatic reserve, launch permission, resource cap or admission policy;
existing kernel guards, routing, quotas and slot caps remain unchanged.

Swap growth uses a recent same-platform baseline: first, reversed-clock,
cross-platform or older-than-five-minute baselines are unknown, growing swap is
positive and shrinking swap clamps to zero. Persisted numeric baselines support
successive one-shot invocations. Consumers must check `sampledAtMs`; history or
a failed write is never proof of current capacity.

Fleet writers share `fleet.json.machine.lock` using the existing owner/identity
lock. Contention or unsafe state preserves the prior file. The adapter re-reads
valid latest fleet state after probes, preserves unrelated fields, writes an
exclusive temporary and atomically replaces the file only after its race check.
Malformed, symlinked, hardlinked, unowned or group/world-writable state is not
replaced. This cannot serialize a legacy writer that ignores the shared lock.
