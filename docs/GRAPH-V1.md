# graph.v1 registry

`phm graph status --json` reads declared agents, engine/account identities,
model catalogs and MCP server identities. This inventory is separate from
`phm universe graph`, which traces experiment evidence. It writes nothing,
starts no agents or collectors, and makes no provider requests.

```sh
phm graph status --fleet ./fleet.json --seats ./seats.json --json
phm graph status --fleet ./fleet.json
```

`--fleet` defaults to `fleet.json` in the current directory. `--seats` selects
an exported seat snapshot. Without it, Phantom reads native account metadata
from `verse.accountsRoot` in its existing config, falling back to
`~/.ashlr/account-connections`. It uses the existing connection validator,
profile reader and model catalog projection. The native roster must be a
valid `connections.json` collector configuration (`schemaVersion: 1`,
`intervalMs`, and a nonempty `accounts` array). Malformed configurations are
reported as invalid, not as a successful empty inventory.

This revision has no standalone `phm seats` command. The explicit snapshot
adapter accepts its intended public seat shape, also used by Verse: either a
seat array or an object with a `seats` array. Use a snapshot to include local
or other non-native seats; the default adapter does not discover them.

## Fleet seed contract

There was no existing fleet.json contract in this checkout. `fleet.v1` is the
versioned input contract introduced alongside `graph.v1`:

```json
{
  "schema": "fleet.v1",
  "agents": [
    { "id": "producer", "seatId": "codex-work", "modelId": "shared", "mcpIds": ["locus"] },
    { "id": "reviewer", "seatId": "claude-work" }
  ],
  "mcp": [{ "id": "locus" }],
  "edges": [
    { "kind": "can-message", "from": "producer", "to": "reviewer" },
    { "kind": "can-delegate", "from": "reviewer", "to": "producer" },
    { "kind": "reviews", "from": "reviewer", "to": "producer" }
  ]
}
```

All three arrays are required, and may be empty. Agent `seatId`, `modelId`,
and `mcpIds` are optional; `modelId` requires a `seatId` and must appear in
that seat's catalog. Agent and MCP IDs must be unique within their respective
lists. Relationships use bare agent IDs, and both endpoints must exist.
`reviews` points from reviewer to reviewed agent. No permissions, review
independence, or MCP access are inferred from membership or shared accounts.
The seed's MCP identities are explicit declarations, not discovery of an
installed or reachable server.

## Seat snapshot contract

```json
{
  "seats": [
    { "id": "codex-work", "engine": "codex", "accountId": "work", "models": [{ "id": "shared" }] },
    { "id": "claude-work", "engine": "claude", "accountId": "work", "models": [{ "id": "shared" }] }
  ]
}
```

Each seat requires `id`, `engine`, `accountId` and `models`. Seat IDs are
unique; model IDs are unique within a seat. Empty seat/model lists are valid.
Engine identifiers are open-ended so exported catalogs can describe future
engines without changing this schema.

Both sources allowlist the documented fields. Commands, args, environment,
health, labels, notes, credentials, profile paths and other extra fields are
never copied into the graph. IDs are public metadata: never put credentials
in them. Identifiers are 1–256 ASCII characters, start with an alphanumeric
character, and otherwise allow alphanumerics and `_.:@/+%-`. Lists are capped
at 10,000 entries. Files are capped at 2 MiB each and read with the existing
stable regular-file reader; unsafe, symlinked, oversized or changing files
are unavailable. Errors contain source names and fixed codes, not raw input
or exception text.

## Output schema

The canonical TypeScript contract is
[`src/core/graph/types.ts`](../src/core/graph/types.ts). The complete example is
the checked-in [golden JSON](../test/fixtures/graph/graph.v1.json).

| Field | Type / meaning |
| --- | --- |
| `schema` | Literal `graph.v1` |
| `readOnly` | Literal `true` |
| `complete` | Both selected sources loaded and validated, with every reference resolved |
| `sources` | `{fleet, seats}`, each `loaded`, `missing`, `invalid`, or `unavailable` |
| `nodes` | Discriminated node array, sorted by ID |
| `edges` | Relationship array, sorted by ID |
| `issues` | Deduplicated `{source, code}` diagnostics, sorted by source/code |

Node variants:

| `kind` | Fields in addition to `id` and `kind` | Identity components |
| --- | --- | --- |
| `agent` | `agentId` | agent ID |
| `engine-account` | `engine`, `accountId`, sorted `seatIds` | engine + account ID |
| `model` | `engine`, `modelId` | engine + model ID |
| `mcp` | `serverId` | MCP server ID |

Node IDs are `kind:` followed by separately `encodeURIComponent`-encoded
identity components joined with `/`. This prevents delimiter collisions and
keeps identically named models on different engines distinct. Seats sharing
an engine/account pair merge into one node retaining all seat IDs.

Each edge has `{id, kind, from, to, source}`. Its ID is
`kind:encodeURIComponent(from)/encodeURIComponent(to)`. Identical edges are
deduplicated; arrays use ordinal ordering, independent of locale or input
order. There are no timestamps, random IDs or machine paths in the output.

| Edge kind | From → to | Source |
| --- | --- | --- |
| `can-message`, `can-delegate`, `reviews` | agent → agent, explicitly declared | `fleet` |
| `routes-to` | agent → engine/account, selected model, or MCP | `fleet` |
| `routes-to` | engine/account → each listed model | `seats` |

Unresolved references emit `unknown-agent`, `unknown-seat`, `unknown-model`,
or `unknown-mcp` issues and omit the affected edge. No dangling edges are
emitted. A malformed source is withheld as a whole; valid nodes from the
other source remain visible. An incomplete graph's counts cover included
nodes and edges only.

## Interpretation and exits

`complete` means a structurally complete projection of the selected inputs.
It is **not** live readiness, routing admission, review approval, credential
validity, model availability, or catalog freshness. Native catalogs may use
Phantom's built-in fallback lists and may contain models unavailable to the
pinned CLI. A `routes-to` edge records a binding or catalog listing, not a
successful execution or permission to execute. Existing runtime gates remain
authoritative. Snapshot freshness is the caller's responsibility.

Exit `0` means complete projection; `1` means a missing, invalid or unavailable
source, unresolved reference, or unexpected read failure; `2` means invalid
arguments. `--json` emits exactly one JSON value. `--help`/`-h` prints help
without reading sources. There are no graph mutation commands.
