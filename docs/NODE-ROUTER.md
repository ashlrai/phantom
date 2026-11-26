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
- **Handing a claim back.** A node that pulls a job it will not run releases
  the claim at once with `phm node release`, so the job returns to pending
  instead of showing as running until the lease lapses. A pool worker
  (`phm node worker`) does the same through the pool's `release` operation; a
  primary too old to know `release` lets the claim expire instead. A temporary
  refusal (the node is stopping, short on capacity or lost the lease) stays
  retryable — omit `--decline`. Only a permanent one (the job needs a lane or
  cap the node lacks, carries secrets the node cannot resolve, or has an
  invalid task) passes `--decline`, and that session is not offered the job
  again. A manual holder that simply stops renewing still lets the lease lapse;
  `release` is the fast path, not a requirement.
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

# While working, keep the claim alive — `renew --watch` repeats renew for you;
# when done, complete (values come from the pull output):
phm node renew --job fix-123 --node box --session 1 --token 5 --leader-token 3 --watch
phm node complete --job fix-123 --node box --session 1 --token 5 --leader-token 3 --result done
# Cannot run it after all? Hand the claim back with the same lease flags —
# add --decline when this session can never run it (missing secret, no pack):
phm node release --job fix-123 --node box --session 1 --token 5 --leader-token 3
# The owner reads the outcome back any time; it answers pending, running
# (with the claiming node), or completed with the accepted result text:
phm node result --job fix-123 --owner acme
# What this owner scope can see:
phm node status --owner acme
```

`phm node join` may omit `--node`: the node id then defaults to this
computer's sanitized hostname — the same default a pool join applies — so
`phm node join --owner <scope>` is the shortest first join. A job with no
live node prints a `phm node join --owner` fix that names the caps it needs.

`phm node result --job <id> --owner <scope>` is the read-only way back to a
job's outcome: `pending`, `running` (naming the node whose live claim can act),
`completed` with the accepted `--result` text, executor and completion time, or
`absent` for an unknown id or another owner's job. It never mutates state —
`withdraw` stays the only fence, and a producer withdrawal reads back as
`completed` with `producerWithdrawn` set, not as node work.

A text `pull` (no `--json`) prints the same claim for a person: the job's
owner, requirements, pack and secret names, the embedded task text when the
job carries one, the lease token pair and expiry, and paste-ready `renew`,
`complete` and `release` commands — the last names `--decline` for a job this
node can never run.

The other verbs print plain-words outcomes too: `join` answers in a sentence
naming the node, session, owner scopes and caps, states the 30-second session
expiry, prints the keep-alive `beat --watch` command and says the registry is
local to this machine — only jobs enqueued on this computer reach the node
(`"registry":"local"` in `--json`); `status`/`list` name
the node holding each running claim (`claimed by`, or `no live claim` once the
claim lapsed or was fenced), show each node's advertised slot bound (`slots=N`,
or `slots=unbounded` when no bound was ever reported — an absent bound is
legacy routing, not a measured zero) and its last measured hold as
`held=<reason>` while one is reported, name the `phm node join` command that
restores each expired node's last advertised profile (the same hint a
session-expired error prints), mark producer withdrawals, carry the
same fix `phm node plan` prints on a job that still has no taker, and an
empty scope says so with the join command; `enqueue` says when the job id already
exists;
`withdraw` names `held` (a live claim still owns it — retry after it lapses),
`completed` and `absent`; `renew` prints the lease expiry as a time;
`complete` and `leave` name what happened, a refused `leave` names the
live session and its command, and `release` says the job is pending again —
with `--decline`, that this session is barred from being offered it.

Add `--json` to any verb for deterministic output:
`{"schemaVersion":1,"command":"pull",...}` on success, or
`{"schemaVersion":1,"command":"pull","error":{"code","message","fix"}}` on failure.
Every `phm node` verb keeps that envelope — the fleet verbs, `pool`, `watch`,
`worker`, `self-update`, `capacity`, `route`, `lanes`, `bridge`, and unknown
verbs or bad arguments at the dispatcher. `error.code` names the refusal
(`usage` or a verb-specific code such as `missing-flag`, `session-expired` or
`lease-lost`); exit 2 is bad usage, exit 1 a lost session/lease or operational
failure, and pool or store failures never echo remote or secret detail. A Mac
with no `node-pool/config.json` gets `code:"error"` naming the missing
configuration — and whether a standalone registry is present — with the
configure-a-pool-or-use-standalone-verbs fix.
The stdin/stdout protocols keep their own shapes: `run-once` replies and
`rpc` requests, and `light`'s `muse.light.v1` report.
Exit codes: 0 ok, 1 lease or session lost or store unavailable, 2 bad usage.

`phm node beat --capacity '<json>'` carries one self-measured host sample —
`{"hostId","ramBytes","slots","held","sampledAtMs"}` — which the router uses for
slot-aware admission and host grouping. Do not hand-write it: `phm node measure`
prints the exact object to paste (`--capacity "$(phm node measure)"`), measured
on this machine under the same rules the pool worker applies, so manual and
worker samples cannot drift apart. The memory reading is measured on this
machine — macOS kernel telemetry or Linux /proc — and a platform with no reader
reports `memory-unmeasured`. `held` is `null` or `memory-unmeasured`,
`memory-pressure`, `disk-unmeasured` or `disk-pressure`, and a held node reports
`"slots":0`. A node held for a reason the sample cannot express (`cpu-*`,
`host-slots-*`) makes `measure` exit 1; omit `--capacity` on that beat, as the
worker does, so the node reads unknown rather than wrongly ready. A `--capacity`
value that is not one JSON object in that shape is refused as `bad-capacity`
(exit 2) before the beat is recorded; its fix prints the `measure` command.

A standalone session expires 30 seconds after its last beat, so
`phm node beat --watch [--every <seconds>]` keeps one alive in the foreground:
each pass is the ordinary `beat` through the same dispatch (a pooled Mac still
delegates to the primary), re-measuring the `--capacity` sample and host stats
on this machine unless the caller passed those flags explicitly. The interval
defaults to 10 seconds and is capped at 25, inside the expiry window. Ctrl-C or
SIGTERM stops the loop and prints a confirmation; a beat that exits non-zero —
a lapsed session, a refused flag — stops it at once with that beat's error. The
watch flags are consumed by the dispatcher and never reach the beat parser, so
older stores and pool primaries see only the usual beat arguments.

`phm node renew --watch [--every <seconds>]` is the claim-side counterpart: a
pull's lease expires 30 seconds after the last renew, so a job that takes
minutes loses its claim mid-run unless something keeps renewing. While a pulled
job is being worked, the watch repeats the ordinary `renew` — the same job,
node, session, token and leader token from the pull output — on the same
interval bounds, through the same dispatch (a pooled member still delegates to
the primary). The watch flags never reach the renew parser either. A refused
renew — a lost lease or dead session — stops the watch at once with that error;
Ctrl-C stops it cleanly and the claim then expires on its own, after which the
job can be pulled again. Without `--watch`, a manual holder renews by hand
before the lease lapses.

## When something is refused

Every error ends with a fix. A job with no taker is shown by `phm node plan`
with the reason: no live node in that owner (join one), no node advertising the
caps (rejoin with them), or no node with a local `gh` login (`gh auth login`,
then `phm node beat --probe-auth`). A `session-expired` error — from `beat` or
`pull` — means the node's heartbeat lapsed: its `fix` prints the rejoin command,
carrying the node's last advertised owner scopes, caps and slots while the
registry still holds the record (placeholders when it does not). If the node
already rejoined under a newer session, the fix names that session and the
exact `leave` command instead, so an operator who lost track of the number can
resume without re-joining again. A `node-live` error from a standalone `join`
names the live session the same way; a pool `join` reports `node-live` when
this computer's node id already holds a live session (a running worker or an
unexpired join) and its fix points at `phm node status --json`. `leave` under
a stale session answers `"left":false` with
`liveSession` and a ready `next` command; use the current session number.
`pull` answers `{"pulled":false}` only while the session is live, so "no job"
never masks a dead session. The same answer carries this node's own admission
facts when it has them — `slots` (the advertised bound, absent when unbounded)
and `held` (the last measured capacity hold) — so an idle node can tell an
empty queue from held capacity; text mode says so in plain words. A
`lease-lost` error means stop work on that job
and pull again. A flag value outside its documented range — `--usage` above
1000 permille or `--slots` above 64 on `join` or `beat` — is refused as usage
(exit 2, `bad-usage` or `bad-slots`) naming the flag and its range, before the
beat or join is recorded. A flag value of the wrong shape is refused the same
way, naming the flag: ids that cannot name a node, owner, job or pack are
`bad-node`, `bad-owner`, `bad-job` or `bad-pack`; cap lists with an invalid cap
are `bad-caps` or `bad-requires`; a `--secrets` name outside
`SCREAMING_SNAKE_CASE` is `bad-secrets`; and an embedded task whose digest is
not `sha256:<64 lowercase hex>` or does not match the text is
`bad-task-sha256`, while text the pack cannot carry is `bad-task`. These are
usage errors (exit 2) before anything is recorded — never an operational
failure about the registry. A verb missing its required `--owner` names what
the store already knows — the scopes present, or the `phm node join --owner
<scope>` that creates the first on an empty store — instead of a bare "add
--owner" dead end.

## Version drift

A node advertises its build as a `phm-<version>` capability when it joins — a
pool worker sends it explicitly and a standalone `phm node join` adds it
automatically (a cap, so a primary on an older build still accepts the join, and
the node's own build replaces any stale `phm-*` cap copied into `--caps`).
`phm node self-update --owner <scope> --json` compares every node against this
machine's version (or `--target x.y.z`) and prints a plan. It is plan only: it
never updates or restarts a node. A node showing `unreported` predates this or
has not rejoined. Update primary and backup first, then workers.

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
— so a shed lane never reports phantom room. A fresh dispatcher pause or
explicit fleet admission stop sets every lane's `available` to zero, including
when the fleet-wide cap is reached. Four local reads run concurrently,
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
been placed. Nodes that report a capacity sample share one physical host's
measured slots, so their free capacity is counted once per host — the smallest
advertisement minus every claim on it — the same grouping the router's
`nodeCapacityView` uses; a node without a sample is its own host.

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
CPU headroom is 85% of cores minus busy cores. Measured zero CPU headroom
blocks placements even when CPU cost per session is unknown or recorded as zero.
It also reduces measured runnable counts to zero, including in fleet totals
that read older capacity documents. Unmeasured harness counts remain null.
Kernel pressure above normal or swap growth stop placements and reduce
measured runnable counts to zero in fleet totals. Both reads honor direct
measurements and recorded limiter labels. A cloud
CLI therefore costs a node only its own measured footprint. A whole-host
backoff only happens when one of those gates is hit. A harness never seen on
the node reports `null` (unknown), never a guess. The previous document supplies swap growth and footprints
learned in the last 7 days.

`phm node route` scores each job's feasible placements by learned lane merge
rate per token and per minute, using one or more capacity documents, a
cost/latency file (`[{provider, model, harness, tokensPerJob, minutesPerJob}]`)
and lane outcomes (`{provider: {attempts, merged}}`). It prints a plan only; it
never launches work. Providers passed with `--exhausted` are never routed.
Input can contain several snapshots for one node ID. Routing and fleet-wide
runnable totals use the newest timestamp per node, so copying a snapshot
cannot increase capacity and a newer hold takes precedence. Conflicting
inputs at the same newest timestamp leave that node's capacity unknown.
For a node without its own harness footprint, routing can borrow measurements
from other nodes whose latest snapshots pass the same freshness check.
A borrowed footprint uses the largest observed memory and CPU costs for the
harness independently. CPU cost stays `null` when no donor measured it.
A fresh snapshot from a node under pressure or swap growth can still supply
a footprint. If no eligible measurement exists, the router reports
`footprint-unmeasured` for that candidate.

An unplaced job's `rejected` counts name why: `provider-not-in-job` and
`model-not-in-job` count cost rows the job's own provider/model lists excluded,
`node-capacity-conflict` marks conflicting current inputs for one node, and
`no-costs`/`no-nodes` mean the inputs held no usable cost rows or node
documents, and the remaining keys (`node-stale`, `node-pressure`, `memory`,
`cpu`, `provider-not-on-node`, ...) count per-node or per-candidate failures.

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
