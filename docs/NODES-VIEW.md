# Nodes view

See every computer that joined this Phantom fleet: its role, capabilities,
how long ago it last checked in, which jobs it is running, and which one holds
the leader lease. It appears in the desktop app on the Fleet Dashboard (the
Mission Control view) as a **Nodes** panel, and in the terminal as `phm nodes`.

Each node uses only its own local login. Nothing here copies, sends or shows a
token; a node reports only the state of its own GitHub login
(`ok`, `missing` or `unknown`).

## Copy-paste example

```bash
phm nodes
phm nodes --json
phm nodes --json --now 2026-11-02T12:00:30Z   # fixed clock, repeatable output
```

Human output (one line per node, `★` marks the leader):

```text
Nodes (3) · leader: mac-mini-1
  lima-vm-2  standby  down  heartbeat 4m  jobs 0  gh-auth unknown  caps arch:arm64,gh,os:linux
  local  worker  ready  heartbeat 2s  jobs 0  gh-auth unknown  caps arch:arm64,os:darwin
★ mac-mini-1  leader  ready  heartbeat 8s  jobs 2  gh-auth ok  caps arch:arm64,codex,gh,os:darwin
```

`--json` prints one object, `phantom.nodes.v1`: `generatedAt`, `leaderId`,
`nodes[]` (`id`, `role`, `owners`, `caps`, `status`, `heartbeatAt`,
`heartbeatAgeMs`, `liveJobs`, `ghAuth`, `leader`, `source`) and `problems[]`
(`file`, `problem`, `fix`). Nodes are sorted by id and time comes from one
clock reading, so the same inputs give the same bytes.

## How a node appears

A computer joins the node router with `phm node join --node <id> --owner
<scope> [--caps <cap>] [--slots <n>] --json` and keeps its lease alive with
`phm node beat` (see [NODE-ROUTER.md](NODE-ROUTER.md)). The shared registry is
one private state file, `~/.ashlr/nodes/nodes.json` (honours `ASHLR_HOME`),
validated by the same `parseState` the router uses — the view adds no second
store and writes nothing.

- `role` is derived, not stored: the live leader-lease holder reads `leader`,
  the designated pool backup (or a node still holding a dead lease) reads
  `standby`, everyone else `worker`.
- `leader` is the badge: true only while the lease is unexpired and the
  holder's own node record is live under the same session — the same check
  the router applies before routing work.
- `liveJobs` lists running jobs whose claim has not expired.
- `ghAuth` is the node's last self-reported auth heartbeat (`ok`, `missing`,
  `unknown`); it is a state word, never a credential.
- This machine always appears as `local`, proven by the daemon heartbeat.

Status: `ready` while the heartbeat lease is live, `stale` when the last beat
is over 90 s old but the record has not expired, `down` once the lease expires
(default 30 s TTL) or the beat is over 5 min old, `unknown` if the record
carries no usable heartbeat.

## Safety and errors

- Read-only. The registry is parsed with the router's strict `parseState`
  validation after an allow-list scan; unknown fields are ignored.
- A registry containing a token-shaped string is dropped unread and reported
  by file name only. The value is never printed or logged.
- Every entry in `problems` ends with a fix. Exit code is 0 for a readable
  view, 2 for bad arguments.
