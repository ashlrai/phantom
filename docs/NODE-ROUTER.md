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
  state always produces the same plan. A node that has not reported load reads
  `usage:null` in `--json` and `usage=unknown` in text — never a fabricated 0.
  Placement is unchanged: an unreported node still counts as no observed load.
- **Owner scope.** Every job carries an owner. A node declares the owners it
  belongs to (`--owner acme`) and only ever sees, routes or pulls jobs of those
  owners. Another owner's jobs, packs, secret names and nodes never appear in
  its output. A job without an owner is never routed.
- **Leases and fencing.** Pulling a job takes a lease (30 seconds by default)
  and a fencing token that only ever increases. Renew before it expires. If a
  node stalls, the lease lapses and another node can pull the job with a higher
  token; the old holder's renew and complete are then refused. Two nodes racing
  for one job get exactly one claim. Pass the token to every external effect so
  a paused node cannot act after losing the job. Only a claim its session can
  still act on consumes capacity: a lapsed claim is re-routable, and a claim
  fenced by a rejoin or departure frees the node's slot and host budget at
  once even though the job itself stays fenced until the claim expires.
- **Handing a claim back.** A pool worker (`phm node worker`) that pulls a job
  it will not run releases the claim at once through the pool's `release`
  operation, so the job returns to pending instead of showing as running until
  the lease lapses. A temporary refusal (the node is stopping, short on
  capacity or lost the lease) stays retryable. Only a permanent one (the job
  needs a lane or cap the node lacks, carries secrets, or has an invalid task)
  declines the job, and that session is not offered it again. A primary too old
  to know `release` lets the claim expire instead. `release` is not a
  standalone `phm node` verb: a manual holder stops renewing and lets the
  lease lapse.
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
claim-to-completion duration over 24 hours; a producer withdrawal is a fence,
not an execution, and adds no sample. Missing latency uses the mean of
measured host medians (equal weights when none exist). Unknown duration is never
reported as zero. Owner, capability, local-auth and fencing checks still apply.

`phm node status --json` exposes scoped capacity samples. `phm fleet status-api
--json` and the existing Fleet compute API add lane occupancy, targets, floors
and queued counts from dispatcher status. Lane `available` counts slots against
the launch target — the configured target tightened by the controller's
`effective_target` load-shed ceiling (`effectiveTarget`, null when unpublished)
— so a shed lane never reports phantom room. Four local reads run concurrently,
each capped at 2 MiB and 250 ms, with phase status; no SSH probes or writes.
Lane availability expires after two 30-second dispatcher intervals.

This connects the existing node-pool dispatch path. The `ready.tsv` to node
claim bridge is described in [Ready queue bridge](#ready-queue-bridge); this
projection does not enqueue production jobs twice or install any fleet scripts.

## Ready queue bridge

`phm node bridge --json` is a dry run. It lists every `ready.tsv` row, says if
the row would go to a node, and gives a reason code for each row that stays
local. `phm node bridge --apply --json` runs one claim and reconcile pass. When
`~/.ashlr/node-bridge.json` holds `{"enabled": true, "owner": "<scope>"}`, the
resident daemon runs the same pass as the bounded `node-bridge` tick phase
(30 s deadline, AbortSignal, status record). The phase spawns
`src/core/drive/nodes/ready-bridge-child.ts` by path and does not import it,
so the bridge stays out of the daemon's Tier-1 import closure. On abort the
phase sends SIGTERM, then SIGKILL after 2 s. Optional settings are `maxPerPass`
(default 4) and `pendingTtlMs` (default 300000).

The bridge uses the claim that dispatchd already honors, so the pinned
dispatcher needs no change:

1. It holds `queue/dispatchd.tick.lock` without waiting (a running tick wins
   and the pass reports `held: dispatcher-tick-busy`), then `queue/ready.lock`.
   Apply passes keep both locks through reconciliation and router publication;
   a second pass cannot reconcile a staged manifest before its enqueue finishes.
2. Under those locks, it reads the router view and ready rows, checks that no
   `.batched`, `.dispatched`, `.reaping` or `.line` marker and no worktree exists, and writes
   `queue/batches/RQ-BATCH-NODE-<hash>.json` (schema `phantom.node-bridge.v1`)
   bound to the current owner and router-store scope.
   Then it creates `queue/run/<job>.batched` with `O_EXCL` and removes the row
   from `ready.tsv`. dispatchd skips a leased row (`SKIP_BATCHED`). Its
   `LEASE_ORPHANED` sweep keeps a lease whose `RQ-BATCH-` owner has a manifest.
   Restock and the batcher skip leased rows.
3. It enqueues router job `ready:<job>:<attempt>` with the lane cap, the pack
   cap and any `needs` before releasing the locks. It never adds secret values.
4. Each later pass calls `phm node withdraw` for running jobs and for pending
   jobs older than `pendingTtlMs`. Withdraw leaves a live claim alone. It
   finishes a pending or lapsed job with a fresh fencing token, so the old
   holder's `renew` and `complete` fail and no node can pull the job again. Only
   after re-reading the manifest and router view under both locks does the row
   go back to `ready.tsv` and the lease get released. An accepted completion
   keeps its lease and manifest as a tombstone, so the row is never relaunched.

Reconciliation holds a manifest owned by another owner as `hold-owner-mismatch`,
or one with a missing or changed router-store scope as `hold-router-mismatch`;
both preserve the row, lease and manifest without withdrawing or requeueing.

A ready row with a `needs` value other than an array of strings, or a
`data_class` that is not a string own key of `DATA_CLASSES`, stays local with
`needs_invalid` or `data_class_invalid`, respectively. A row whose status or
lane cell carries the dispatcher's `PARKED-` hold marker (either ready.tsv
dialect) stays local with `parked_row`, whatever its requirements spec says —
held work is never offloaded.

The bridge does nothing and reports `inert` with one of these reason codes:
`bridge-owner-unset`, `bridge-disabled` (when `--apply` is used without
config), `bridge-config-invalid`, `stopped` (`KILL`, `PAUSE` or
`queue/NODE_BRIDGE_OFF`), `queue-absent`, `dispatcher-absent`,
`dispatcher-lease-unsupported` (the installed `~/.ashlr-runs/bin/dispatchd.py`
lacks the lease protocol), `router-unavailable`, `not-pool-primary` or
`owner-not-pool-scope`. On a pool primary the bridge goes through the witness
(`callPool`). A demoted primary never claims.

A row stays local with one of these reasons: `invalid_row`,
`invalid_requirements`, `parked_row`, `data_class_invalid`, `needs_invalid`,
`duplicate_row`, `host_bound_job` (`RQ-FIX-MAIN-`,
`RQ-REL-`, `RQ-DESK-`, `RQ-BATCH-`), `local_claim_present`, `exclusive`,
`local_execution_required` (`codex-local`, `omlx`), `lane_not_remote` (`devin`,
`claude-api`), `data_class_exceeded` (above `internal`, the clearance
work_market gives remote built-ins), `requirement_unverifiable` (`min_tier`,
`max_tier` or `max_cost_class`, which no node reports), `need_not_routable`,
`no_live_node`, `lane_mismatch`, `pack_inert`, `node_pack_unsupported`,
`caps_missing`, `slots_unknown` (a node sent no slot telemetry, which is
unknown, not zero), `pass_limit` or `no_free_slot`. Free slots are a node's
`slots` minus its running claims, after router jobs that are still waiting have
been placed.

### Capabilities come from a local probe

A worker advertises `codex` or `claude` only when `resolveProviderBinary`
finds the binary in its absolute allowlist (no `PATH` lookup) and the
binary's sign-in check exits 0. See [node runner](NODES.md#reference-runner-security-review-before-installation).
A node without the binary never advertises the lane, so the router never
offers it a job that needs the lane.

Pack caps come from the runner too. At join the worker runs
`<runner> packs`. The runner must exit 0 within 5 s and print
`{"protocol":"phm-node-worker/v1","packs":[...]}`. The worker then advertises
`pack:<name>` for each valid name, up to 16. The reference runner answers
through `phm node run-once packs`. A runner that does not support `packs`, or
that times out or prints anything else, advertises no pack caps. Rows then
report `node_pack_unsupported` instead of being offered. Pack caps are never
read from config.

### Which ready rows map onto remote packs

The runner (`~/.ashlr-runs/bin/node-runner`, `phm-node-worker/v1`) supports
`shell-check`, `omlx-ping` and `codex-file`. `codex-file` is codex exec in a
read-only sandbox.

| Ready row | Remote pack | Status |
| --- | --- | --- |
| Read-only review or research (`RQ-REVIEW-`, `RQ-RESEARCH-`, `RQ-AUDIT-` on a codex lane) | `codex-file` | Routable to nodes that advertise `pack:codex-file` |
| Code-writing rows (all other kinds) | `codex-worktree` | Designed, inert (`pack_inert`) |
| Local-model, exclusive, host-bound or classified above `internal` | none | Always local |

The planned `codex-worktree` pack would make a fresh worktree on the node from
the row's repository at its base commit. It would run codex with the
worktree-write sandbox and no network except the provider, and return only a
bundle reference fenced by the claim token. Publishing would stay with the
primary's publisher. Until that pack is reviewed and a node advertises
`pack:codex-worktree`, `NODE_BRIDGE_WORKTREE_PACK_ENABLED` stays false and
code-writing rows stay local.

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

The outcomes file is optional to maintain by hand: `--outcomes-ledger` derives
the same `{provider: {attempts, merged}}` tallies from
`<runs-dir>/metrics/jobs.jsonl` (default `ASHLR_RUNS_DIR`, then
`~/.ashlr-runs`; `--runs-dir` requires the flag). A job counts as an attempt
only when its merge verdict is known — MERGED or CLOSED — so in-flight and
aborted work never deflates a lane's rate; a merge recorded as reverted
counts as an attempt but not as a held merge; an absent ledger means no
recorded outcomes, while an unreadable one refuses the route. Explicit `--outcomes`
entries win per provider over ledger tallies, and the JSON plan reports the
ledger state, truncation and provider count under `outcomes_ledger`.

## Limits

State is a private local directory (`~/.ashlr/nodes`, or `$ASHLR_HOME/nodes`)
shared by processes on one host; see [the store notes](../src/core/drive/nodes/README.md)
for the single-host guarantee and failover rules. The path may be spelled
through symlinks — a scratch `$ASHLR_HOME` under macOS `$TMPDIR` resolves
`/var` to `/private/var` — and the store canonicalizes it before the
private-directory checks; the resolved directory must still be owned and
private (0700). Fencing guarantees one
accepted completion, not exactly-once external effects, so effect sinks must
reject stale tokens. Owner scope filters what nodes and operators read through
these commands; it is not an access-control boundary against someone who can
read the state directory itself.
