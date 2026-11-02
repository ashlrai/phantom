# Nodes view

See every computer that joined this Phantom fleet: its role, capabilities,
how long ago it last checked in, which jobs it is running, and which one holds
the leader lease. It appears in the desktop app on the Fleet Dashboard (the
Mission Control view) as a **Nodes** panel, and in the terminal as `phm nodes`.

Each node uses only its own local login. Nothing here copies, sends or shows a
token; a node reports only the state of its own GitHub login
(`ok`, `missing`, `expired` or `unknown`).

## Copy-paste example

```bash
phm nodes
phm nodes --json
phm nodes --json --now 2026-11-02T12:00:30Z   # fixed clock, repeatable output
```

Human output (one line per node, `★` marks the leader):

```text
Nodes (3) · leader: mac-mini-1
  lima-vm-2  worker  stale  heartbeat 4m  jobs 0  gh-auth expired  caps arch:arm64,gh,os:linux
  local  worker  down  heartbeat never  jobs 0  gh-auth unknown  caps arch:arm64,os:darwin
★ mac-mini-1  leader  ready  heartbeat 30s  jobs 2  gh-auth ok  caps arch:arm64,codex,gh,os:darwin
```

`--json` prints one object, `phantom.nodes.v1`: `generatedAt`, `leaderId`,
`nodes[]` (`id`, `role`, `caps`, `status`, `heartbeatAt`, `heartbeatAgeMs`,
`liveJobs`, `ghAuth`, `leader`, `source`) and `problems[]` (`file`, `problem`,
`fix`). Nodes are sorted by id and time comes from one clock reading, so the
same inputs give the same bytes.

## How a node appears

Each node writes its own record to `~/.ashlr/nodes/<id>.json` (honours
`ASHLR_HOME`) on every heartbeat:

```json
{"id":"mac-mini-1","role":"worker","caps":["os:darwin","gh"],"heartbeatAt":"2026-11-02T12:00:00Z","liveJobs":["job-7"],"ghAuth":"ok"}
```

The fleet lease holder writes `~/.ashlr/nodes/leader-lease.json`
(`{"holder":"mac-mini-1","generation":12,"expiresAt":"..."}`). The leader badge
shows only while the lease is unexpired and the holder is not `down`; a record
that claims `role: leader` without the lease is shown as `standby`. This
machine always appears as `local`, proven by the daemon heartbeat.

Status: `ready` (heartbeat within 90 s), `stale` (within 5 min), `down`
(older), `unknown` (no heartbeat).

## Safety and errors

- Read-only. Records are parsed with an allow-list; unknown fields are ignored.
- A record containing a token-shaped string is dropped unread and reported by
  file name only. The value is never printed or logged.
- Every entry in `problems` ends with a fix, for example "Delete bad.json; the
  node rewrites it on its next heartbeat". Exit code is 0 for a readable view,
  2 for bad arguments.
- If no other node has registered, only `local` shows. Nothing is invented.

The NODES-1 registry, NODECAPS and the `fleet.mission.v1` projection are not in
this checkout; this view reads the node and lease files above and is the
adapter point for them.
