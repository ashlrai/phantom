# Node router

Any computer can join Phantom as a node. The box coordinator is just one more
node: it joins, advertises what it can do, and pulls work like the rest. The
router decides which node gets each job, and a lease makes sure a job never
runs on two nodes.

## What the router does

- **Caps.** A node advertises capabilities (`--caps build,gh`). A job lists what
  it needs (`--requires build`). Only nodes with every required cap are eligible.
- **Live usage.** Each node reports load with every heartbeat (`--usage 0-1000`,
  permille). The router sends the job to the least-loaded eligible live node,
  counting jobs the node already holds, and breaks ties by node ID. The same
  state always produces the same plan.
- **Owner scope.** Every job carries an owner. A node declares the owners it
  belongs to (`--owner acme`) and only ever sees, routes or pulls jobs of those
  owners. Another owner's jobs, packs, secret names and nodes never appear in
  its output. A job without an owner is never routed.
- **Leases and fencing.** Pulling a job takes a lease (30 seconds by default)
  and a fencing token that only ever increases. Renew before it expires. If a
  node stalls, the lease lapses and another node can pull the job with a higher
  token; the old holder's renew and complete are then refused. Two nodes racing
  for one job get exactly one claim. Pass the token to every external effect so
  a paused node cannot act after losing the job.
- **Local auth only.** Jobs needing `gh` go only to nodes whose own heartbeat
  reports a working GitHub CLI login (`phm node beat --probe-auth` runs
  `gh auth status` locally and reads only its exit code). Phantom never copies,
  stores or sends a token. Jobs carry secret **names** (`DEPLOY_KEY`), which each
  node resolves from its own custody; values are rejected at enqueue.

## Copy-paste example

```sh
# On each computer (the box coordinator included):
phm node join --node box --owner acme --caps build,gh --json   # prints a session number
phm node beat --node box --session 1 --usage 120 --probe-auth --json

# Anyone in the owner scope queues work:
phm node enqueue --job fix-123 --owner acme --requires gh --pack pack-fix-123 --secrets DEPLOY_KEY --json

# See where it would go, then pull on the node that should run it:
phm node plan --owner acme
phm node pull --node box --session 1 --json

# While working, renew; when done, complete (values come from the pull output):
phm node renew --job fix-123 --node box --session 1 --token 5 --leader-token 3
phm node complete --job fix-123 --node box --session 1 --token 5 --leader-token 3 --result done
# A claim you will not run is handed back at once (job returns to pending; this session is not offered it again):
phm node release --job fix-123 --node box --session 1 --token 5 --leader-token 3

# What this owner scope can see:
phm node status --owner acme
```

Add `--json` to any verb for deterministic output:
`{"schemaVersion":1,"command":"pull",...}` on success, or
`{"schemaVersion":1,"command":"pull","error":{"code","message","fix"}}`.
Exit codes: 0 ok, 1 lease or session lost or store unavailable, 2 bad usage.

## When something is refused

Every error ends with a fix. A job with no taker is shown by `phm node plan`
with the reason: no live node in that owner (join one), no node advertising the
caps (rejoin with them), or no node with a local `gh` login (`gh auth login`,
then `phm node beat --probe-auth`). A `lease-lost` error means stop work on
that job and pull again.

## Version drift

A worker advertises its build as a `phm-<version>` capability when it joins (a cap,
so a primary on an older build still accepts the join). `phm node self-update
--owner <scope> --json` compares every node against this machine's version (or
`--target x.y.z`) and prints a plan. It is plan only: it never updates or
restarts a node. A node showing `unreported` predates this or has not rejoined.
Update primary and backup first, then workers.

## Live pool awareness

Configured multi-Mac pools consume the capacity slice of `fleet.awareness.v1`
inside their existing fenced `plan` and `pull` transactions. Workers report capacity (`ramBytes`, `slots`,
`held`), host identity and a sample timestamp on each three-second heartbeat.
After two intervals, missing, future or stale samples are unknown and admit no
new work. A heartbeat without a capacity sample cannot refresh old capacity.
Upgrade the witness and workers together; older workers stay unknown in a pool.
Standalone legacy queues retain their existing compatibility policy.

Workers reporting the same host share the minimum fresh slot budget. Active
claims and planned assignments consume it once; a fresh pressure hold blocks
that host. Placement ranks remaining slots divided by the median accepted
claim-to-completion duration over 24 hours. Missing latency uses the mean of
measured host medians (equal weights when none exist). Unknown duration is never
reported as zero. Owner, capability, local-auth and fencing checks still apply.

`phm node status --json` exposes scoped capacity samples. `phm fleet status-api
--json` and the existing Fleet compute API add lane occupancy, targets, floors
and queued counts from dispatcher status. Four local reads run concurrently,
each capped at 2 MiB and 250 ms, with phase status; no SSH probes or writes.
Lane availability expires after two 30-second dispatcher intervals.

This connects the existing node-pool dispatch path. The production
`ready.tsv`/dispatchd-to-node claim bridge is still absent; this projection does
not enqueue production jobs twice or install any fleet scripts.

## Measured capacity and (node, provider, model) routing

Nodes have no per-node lane configuration. Each node measures itself and reports
how many more agent sessions of each harness it can start now:

```bash
phm node capacity --out ~/.ashlr-runs/metrics/node-capacity.json --json
```

The document (`phantom.node-capacity.v1`) carries `node`, `measured_at`, `cpu`,
`mem_free`, `swap`, `per_harness_footprint`, `agents_runnable_now` and `basis`.
A harness session is the vendor CLI plus every child it spawns (MCP servers,
tool runners), measured with `ps`, or with `pgrep` and `footprint` where `ps` is
denied. Memory headroom is the memory above memguard's raise line (30% free).
CPU headroom is 85% of cores minus busy cores. Kernel pressure above normal,
or swapouts at memguard's growth rate, stop every harness on that node. A cloud
CLI therefore costs a node only its own measured footprint. A whole-host
backoff only happens when one of those gates is hit. A harness never seen on
the node reports `null` (unknown), never a guess. The previous document supplies swap growth and footprints
learned in the last 7 days.

`phm node route` scores each job's feasible placements by learned lane merge
rate per token and per minute, using one or more capacity documents, a
cost/latency file (`[{provider, model, harness, tokensPerJob, minutesPerJob}]`)
and lane outcomes (`{provider: {attempts, merged}}`). It prints a plan only; it
never launches work. Providers passed with `--exhausted` are never routed.

## Limits

State is a private local directory (`~/.ashlr/nodes`, or `$ASHLR_HOME/nodes`)
shared by processes on one host; see [the store notes](../src/core/drive/nodes/README.md)
for the single-host guarantee and failover rules. Fencing guarantees one
accepted completion, not exactly-once external effects, so effect sinks must
reject stale tokens. Owner scope filters what nodes and operators read through
these commands; it is not an access-control boundary against someone who can
read the state directory itself.
