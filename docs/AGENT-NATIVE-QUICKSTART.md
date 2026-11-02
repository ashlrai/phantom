# Agent-native Phantom quickstart

Use the desktop `/verse/` console as Mason's visibility and control surface:
inspect sessions, the Agents board, checks and fleet observations there. Agents
coordinate through shared state and MCP; a console card is an observation, not
an instruction to launch work. This guide describes the interfaces in this
checkout. `phm` and `ashlr` are aliases; an older installation may differ.

## Open the console and observe

Open Phantom desktop, or run the local browser-backed console:

```sh
phm verse --no-open --json
```

Keep the process running and open the returned `verseUrl`. The local server
binds to loopback. Startup JSON also contains separate read and mutation
tokens: treat the entire output as private. Do not paste it into a prompt,
logs, or an issue. The desktop app manages its own sidecar and credentials;
do not assume it shares the port or tokens of a separately started CLI.

For machine-readable fleet observations and discovery:

```sh
phm fleet status --json
phm fleet watch --json
phm mcp list --json
```

`mcp list` returns `servers`, `tools`, and `native` inventories; it discovers
configuration, not proof that every downstream server is healthy. The fleet
snapshot and watch are read-only. Counts of intentions, queued work, or
proposals are not evidence of agent launches or merges: inspect the actual run,
checks and merged PR evidence. An unavailable or unknown usage value is not
zero. A status is a point-in-time observation, not authorization to act.

## Share state between agents

Configure an MCP client to launch the gateway with command `phm` and arguments
`["mcp"]`. Its `tools/list` advertises native tools and discovered downstream
tools, which the gateway namespaces as `<server>__<tool>`. Discover the
schemas and call only tools actually listed for your client. For example, these
are MCP `tools/call` parameters (the IDs and content are fictional):

```json
{"name":"phm_team_register","arguments":{"team":"demo","agentId":"agent:demo/writer","capabilities":["docs"]}}
```

```json
{"name":"phm_team_publish","arguments":{"team":"demo","agentId":"agent:demo/writer","status":"reviewing"}}
```

```json
{"name":"phm_team_view","arguments":{"team":"demo"}}
```

Registering returns JSON such as `{"registered":"agent:demo/writer","eventId":"fake-event-id"}`;
the event ID shown is illustrative. Team events are appended to the local
`$ASHLR_HOME/teams/<team>/events.jsonl` store, shared by processes using the
same Phantom home. View presence, messages, claims and handoffs with
`phm_team_view`; `phm_team_claim` coordinates leases and `phm_team_handoff`
tracks requests and transitions. Claims can conflict or expire. Registration,
presence, and a handoff request do not grant authority or prove work ran;
consequential handoffs require the owner's approval before acceptance.
`phm_team_context_add` and `phm_team_context_get` store and retrieve scoped,
cited context. Supply the appropriate owner/project scope and provenance;
do not put credentials in messages or context.

The fleet event bus also has **process-local, best-effort threads**. Their
membership and deliveries live in that process; a successful fan-out is not a
durable mailbox, cross-process delivery guarantee, or evidence of execution.
The persisted local team event log is a separate interface, and persistence
alone does not guarantee another agent has read or acted on an event.

For a smaller, read-only MCP surface, launch command `phm` with arguments
`["mcp","fleet"]`. Its tools are `fleet_status` with `{}` and `fleet_loop`
with an optional integer `limit` from 1 to 50. They read local persisted
observations, do not start a tick, and report unknown data as unknown.

## Discover the authenticated HTTP interfaces

For a locally started `phm verse`, obtain `url`, `readToken`, and `token`
privately from that process's startup JSON. Use the read token in the
`X-Ashlr-Token` header for GETs. The following existing routes expose state:

| Method and path | Use |
| --- | --- |
| `GET /api/verse/bootstrap` | Initial console state |
| `GET /api/verse/agents` | Agents board |
| `GET /api/verse/sessions` | Session list and status |
| `GET /api/verse/sessions/:id?after=N` | Session detail and events after a sequence number |
| `GET /api/verse/mcp` | MCP management and seat inventory |

For example, set `PHM_URL` and `PHM_READ_TOKEN` privately from the startup
result, then request a snapshot:

```sh
curl -fsS -H "X-Ashlr-Token: $PHM_READ_TOKEN" "$PHM_URL/api/verse/sessions"
```

Mutations require dispatch enabled, the separate mutation token in the same
header, and JSON content. `POST /api/verse/sessions/:id/cancel` requests
cancellation of that session's current turn. A response such as
`{"ok":true,"cancelled":true}` means the cancellation was accepted; `false`
means no cancellable turn was found. Poll session detail/events for the
subsequent state: a request is not proof that process cleanup has completed.
Session status is `idle`, `running`, or `error`. Cancellation does not undo
side effects or imply a remote session was terminated.

The seat's separate MCP endpoint is `POST /api/verse/agent-tools/mcp` with
`Authorization: Bearer <turn token>`. It is stateless JSON-RPC; use MCP
`tools/list` with the current turn token to discover the tools allowed by that
turn's grants. Turn end, Stop, or revocation invalidates access. This is not the
management endpoint `/api/verse/mcp`, and neither the read nor mutation token
substitutes for the turn token. Desktop-only tools require the desktop app.

## Local knowledge and impact

Enroll the intended repository first using the existing operator workflow.
Set `REPO` to its enrolled path, then run:

```sh
phm knowledge build --repo "$REPO" --json
phm knowledge graph --repo "$REPO" --json
phm knowledge impact src/example.ts --repo "$REPO" --json
```

Indexing uses the local embedding provider; graph and impact perform bounded
local analysis of enrolled repositories. Build output has `repos` and `chunks`;
zero new chunks can mean an incremental index is already current. Graph output
contains `nodes`, `edges`, and `crossRepo`; impact contains `target`,
`references`, and `dependents`. An empty result is not proof of no impact:
scans are bounded and can miss unsupported or inaccessible files. Check the
actual files and tests before changing code.
