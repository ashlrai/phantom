# Nodes view

See joined computers, capabilities, heartbeat age, live jobs and the leader
lease in the Fleet Dashboard's **Nodes** panel or in the terminal:

```sh
phm nodes
phm nodes --json
phm nodes --json --now 2026-11-02T12:00:30Z
```

`phm nodes` is an alias for `phm fleet nodes`, including its argument handling,
output and exit codes. Help and error messages name the canonical command.
Both commands and `GET /api/nodes` use the current node router inventory at
`~/.ashlr/nodes/nodes.json` (honours `ASHLR_HOME`). Join and heartbeat through
[the node router](NODE-ROUTER.md); individual `<id>.json` files and a separate
`leader-lease.json` are not inventory sources.

The `phantom.nodes.v1` JSON snapshot includes `generatedAt`, `sourcePath`,
`observedAt`, `leaderId`, `nodes[]` and `error`. Each row reports `id`, `role`,
`owners`, `caps`, `status`, `heartbeatAt`, `heartbeatAgeMs`, `liveJobs`,
`ghAuth`, `leader` and `source`. Rows, capabilities and job IDs are sorted.
An injected `--now` makes the same inventory repeatable.

Only a live lease matching a registered node's session earns the leader badge.
Running jobs count only while their matching session's claim is live.
Heartbeats older than 90 seconds are stale; expired registrations or heartbeats
at least five minutes old are down. Missing or future heartbeats are unknown.
A missing inventory reports an empty list rather than inventing a local node.

Reads never resolve or copy credentials. Nodes report only their own GitHub
auth state (`ok`, `missing`, or `unknown`). A secret-shaped value anywhere in
the inventory rejects the entire snapshot without echoing the value. Missing,
unreadable, malformed or invalid inventories return an `error` and exit 1;
bad arguments exit 2. Successful reads exit 0.
