# muse light job routing

This runbook covers RQ-MUSE-WIRE-1's isolated light slice. The enrollment and
multi-Mac operations work is tracked separately in PR #5529. Keep the same reviewed
Phantom revision on both Macs and retain the configured owner `ashlr`, node `muse`,
primary and backup SSH aliases. Never reset the witness to recover connectivity.
See [node routing](../NODE-ROUTER.md) and [pool operations](../NODES.md).

## Inventory for the 8 GB node

| Work | Pilot recipe | Admission |
| --- | --- | --- |
| Channel adapter/count reporter | `muse-light:channels-status:v1` | `light,comms` |
| Owner-thread status reporter | `muse-light:comms-status:v1` | `light,comms` |
| Offline documentation link checks | `muse-light:docs-check:v1` | `light` |
| Comms polls with receipt writes or sends | None | Excluded from this read-only pilot |
| Small individual test files | None | Candidate only after measuring RAM and bounding workers |
| Builds, installs, typechecks, full suites, model inference | None | Keep on existing lanes |

The bounded docs command passed on the implementation host with peak RSS
84,770,816 bytes (80.8 MiB), measured with `/usr/bin/time -l`. This is a host
measurement; muse throughput and status-recipe RSS remain unmeasured.

The fixed catalog accepts no shell text, file paths, command arguments or secret
values from the queue. Pilot jobs have no secret references. Other node jobs may
carry names only; any future authenticated recipe must resolve them locally.
`gh` is advertised only when muse's own `gh auth status` succeeds, with its output
discarded. No credentials or auth directories move between hosts.

## Run one bounded batch

Use a reviewed source checkout on muse with its matching `dist/` already built
on the normal build host. The docs recipe also requires that checkout's `docs/`
and `scripts/`; an npm-only install cannot perform source documentation checks.
No build or dependency installation is a light job. The runner must be an owned,
executable regular file in trusted directories; retain its checkout-relative path.

```sh
# On muse, after its normal pool enrollment (owner ashlr, node muse):
phm node worker --light --runner /absolute/phantom/examples/node-pool/light-runner --json

# On the primary: read fresh router evidence and accepted completions.
phm node light status --json
phm node light restock --json
phm node light restock --apply --json
```

`--light` joins with `light,comms` (plus locally qualified `gh`) and two slots.
It fills its own slice after joining, runs at most two commands, then leaves after
both settle. Repeat the bounded worker through the host's existing approved
scheduler; this change installs no supervisor. A provider worker retains its
one-slot 8 GB budget. Do not run both profiles under the same live node session.

Each recipe is queued at most once per hour with a deterministic job ID and
`--owner ashlr --requires light` (plus `comms` where needed). Outstanding jobs
count across hour boundaries, including expired claims; restock never piles up
new work behind a failed pilot. It adds at most two outstanding catalog jobs.
The normal node router still decides the least-loaded eligible executor; another
`ashlr` light node may take work. Completion metrics identify the actual executor.

The worker keeps the existing pressure, unknown-telemetry and 20 GB disk gates,
PAUSE/KILL sentinels, three-second lease renewal and process-group fencing.
Heartbeats report busy-slot usage and slot capacity. Each recipe has a 120-second
deadline and a 256 MiB V8 heap limit; diagnostics are discarded and only an opaque
result reference returns. A failed check cannot produce a completed node job.

## Restock adoption and completion evidence

The restock hook runs independently of normal lane depth only when the host-owned
`~/.ashlr-runs/queue/muse-light.enabled` marker exists. Dry runs never call it.
It serializes restock invocations and uses a three-second child timeout, so an
unavailable node pool leaves lane restock working. IDs make uncertain enqueue
retries safe. Catalog jobs never enter `ready.tsv`, avoiding duplicate execution
by dispatchd. Remove the marker to stop new restock admissions; use muse's existing
PAUSE/KILL controls to stop worker admission/execution.

Adopt the repository restock change only after Security review and re-pinning
through the sanctioned machinery workflow. Never copy a candidate over live bin
files. The worker and CLI are source changes; no live installation was performed.

`phm node light restock --apply --json` writes private, atomic
`~/.ashlr-runs/metrics/muse-light/status.json` (`muse.light.v1`), refreshed from router
state. `museCompleted` counts accepted completions whose claim executor is muse;
pending, running, failed and stale-token attempts never count. The last 20
completion identities are included without command output, results or credentials.
`phm node light status --json` reads current evidence without writing the report.
Reports are observed snapshots, not an exactly-once event ledger.

No live muse completion was observed during this implementation: direct SSH was
refused by the execution environment and configured pool status was unavailable.
The regression suite exercises admission, two-slot execution, accepted completion
attribution and stale-token refusal in isolated fixture state. Capture live status
after the reviewed change is adopted; do not treat fixture counts as production.
