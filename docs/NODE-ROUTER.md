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

## Limits

State is a private local directory (`~/.ashlr/nodes`, or `$ASHLR_HOME/nodes`)
shared by processes on one host; see [the store notes](../src/core/drive/nodes/README.md)
for the single-host guarantee and failover rules. Fencing guarantees one
accepted completion, not exactly-once external effects, so effect sinks must
reject stale tokens. Owner scope filters what nodes and operators read through
these commands; it is not an access-control boundary against someone who can
read the state directory itself.
