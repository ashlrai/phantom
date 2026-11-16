# Fleet graphs and coordination

Use the installed command's help to check availability. These surfaces exist
in the current source; a source checkout does not establish publication or
operation on a particular host.

## Fleet graph

Open **Graph** from the pane menu, or `/verse/?pane=fleet-graph`. It combines
lane and worker relationships from `/api/verse/fleet/runs` with seat and engine
state from `/api/verse/fleet/graph/live`. Worker observations refresh every ten
seconds and live seat state every fifteen seconds while visible. Selecting an
agent reads its direct routes with `?agent=<agentId>`. Unknown readings stay
unknown. **Steer** and **Hand off** open the existing interjection dialog with
prefilled context; the operator still submits the action.

There are two different graph projections:

| Surface | Evidence and meaning |
| --- | --- |
| `phm fleet graph --json` | Router topology (`schema: fleet.v1`, `kind: graph`): leaders, lanes, slots, jobs, PRs and resources from bounded queue files. `--queue-dir` accepts an absolute directory; source states are `known`, `partial` or `unknown`. It neither launches work nor contacts providers. |
| `GET /api/verse/fleet/graph` | Engine/account registry (`graph.v1`): declared agents, seats, model catalogs and MCP identities. `?live=1` adds live observations. |
| `GET /api/verse/fleet/graph/live` | Registry with live state (`graph-live.v1`); optional `agent` scopes the result to an agent and its direct `routes-to` targets. Completeness and source issues remain global. |

The loopback HTTP routes use the console's read authentication. See the
[registry contract](api/FLEET-GRAPH-V1.md) and [fleet API](FLEET-API.md).
A route records a binding, not permission to execute or proof of capacity.

Graph execution commands such as `graph-run`, `graph-observe` and
`graph-resume` are separate from these readers. Inspect their own `--help`
before use: `graph-run` and `graph-observe` preview a manifest unless
`--apply` is supplied. Reusing an observation run ID only deduplicates
transport; it does not make execution idempotent.

## Leader orchestration

Preview one bounded cycle against current host observations or a captured
chief-of-staff snapshot:

```sh
phm fleet orchestrate --snapshot auto --top 3 --json
phm fleet orchestrate --snapshot /absolute/path/snapshot.json --top 3 --json
```

The cycle combines queue ordering, specialist availability, bounded specialist
memory and seven-day outcome advice. `--top` accepts 1–8, default 3. Preview
writes nothing and launches no agents; degraded evidence can produce a report
with `ok: false` and exit 1. Inspect `sources`, `unresolved`, assignments and
the verdict instead of treating process success as readiness.

`--apply` requires a snapshot no older than sixty seconds, an authenticated
host peer session and owner-thread context. Unavailable or degraded source
reads refuse apply. It reserves
specialists, sends advisory assignments through the existing peer bus and
records a desktop owner-thread brief. The existing dispatcher still claims
and executes queue jobs; orchestration launches zero jobs and changes no
routing or spending policy. Session credentials stay in the trusted host's
environment, never in arguments or documentation.

The durable journal is `queue/specialists/orchestration.json` under the host
runs directory. A receipt is `reserved` before sending, `admitted` when a
peer message ID is recorded, and `complete` after a matching later terminal
job observation. A crash can leave an unresolved reservation; inspect it
before retrying rather than clearing the journal to force another assignment.

Open **Channels** (`/verse/?pane=fleet-channels`) for the **Leader orchestration
journal**. It refreshes every fifteen seconds while visible through read-only
`GET /api/verse/fleet/control/orchestration`, with no query parameters. The
endpoint returns the newest 25 assignments, whole-journal counts and unresolved
reservations. MCP `fleet_orchestration_read` adds status/job filters and a
1–100 receipt limit; see the [fleet MCP onramp](FLEET-MCP-ONRAMP.md).

## Teammate work

[iMessage teammate tasks](IMESSAGE.md#fleet-teammate-tasks-and-evidence) provide
scoped work for configured peers, local queue reservations, unsent-task
withdrawal and bounded evidence readers. Their native transport, consent and
send checks remain separate from specialist peer-bus assignments. Neither a
peer DONE report nor an admitted orchestration receipt proves independent
verification, merge or delivery.
