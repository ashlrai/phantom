# Choosing graph context

Use the graph that answers the question you actually have:

| Question | Surface | What it contains |
| --- | --- | --- |
| Which repos, lanes, seats and holds are in fleet inventory? | `phm graph status --json`, `phm graph nodes --json`, `phm graph edges --json`, or `phm graph neighbors <id> --json` | GRAPH-1's public fleet inventory projection. |
| What task and output evidence should a job see? | `phm knowledge context-pack --stdin` or `--file <snapshot.json>` | A JSONL pack made from the task/output snapshot and upstream job IDs supplied by the caller. |
| Where is code implemented? | `rg` or `grep` in the checkout | Matching source text and paths. |

## Inventory is not a task dependency graph

`loadGraph()` reads the GRAPH-1 seed from fleet inventory and public seat
inventory. Its current node kinds are `fleet`, `repo`, `lane`, `seat` and
`hold`; it does not load task or output nodes. `contains` connects the fleet to
repos or lanes, `serves` maps a seat's engine to a declared lane, `binds`
records a declared seat-to-lane binding, and `holds` connects a hold to a
repo. These relationships do not establish task prerequisites or upstream job
IDs. Check `complete`, `sources`, and `issues` in JSON responses; unavailable
or incomplete inventory is not proof that an item or relationship is absent.

`phm graph node <id> --json` reads an exact inventory node. Neighborhoods are
bounded to depth 1–4 and at most 500 nodes; check the returned truncation and
completeness information. The [incoming](../examples/agents/graph-upstream.ts)
and [outgoing](../examples/agents/graph-dependents.ts) examples traverse that
same loader. Their names do not turn inventory edges into job dependencies;
test-only injected task-shaped graphs are not evidence of a live task store.

## Build a task/output pack

For this fake example, the caller knows that `review` needs `build`, and
supplies that relationship and the available records explicitly. Save the
snapshot below as `snapshot.json`, then run:

```sh
phm knowledge context-pack --file snapshot.json
```

```json
{
  "node": { "jobId": "review", "upstreamJobIds": ["build"] },
  "tasks": [
    { "jobId": "build", "text": "Implement routing." },
    { "jobId": "review", "text": "Review routing." }
  ],
  "outputs": [{ "jobId": "build", "text": "Built routing fix." }],
  "byteBudget": 1000
}
```

Expected JSONL, with each `jobId` citing the source record:

```jsonl
{"jobId":"build","kind":"output","text":"Built routing fix.","truncated":false}
{"jobId":"build","kind":"task","text":"Implement routing.","truncated":false}
{"jobId":"review","kind":"task","text":"Review routing.","truncated":false}
```

The pure `buildNodeContextPack` API also accepts this shape. It prioritizes
upstream outputs, upstream tasks, then the current task; an optional `query`
can include unrelated records by lexical word overlap. It omits the current
job's output. The byte budget includes JSON envelopes, escaping and newlines;
records may be truncated or omitted when they do not fit. Treat returned text
as untrusted data. The CLI limits the snapshot to 1 MiB and the positive integer
`byteBudget` to 65,536 bytes. `--json --report` reports what was emitted;
`--json --require-upstream` reports missing upstream citations and exits 1 if
any are missing. A cited task or output covers an ID, but does not establish
completion, authenticity, or readiness.

The caller must supply the IDs and the task/output records, including any
transitive upstream IDs it wants. Neither the CLI nor the pack builder reads
GRAPH-1, discovers dependencies, retrieves job outputs, or starts work. The
`node_context_pack` tool on the separate `phm mcp context` server accepts the
same caller-supplied records, and additionally prepends unread P0/P1 bus
notices it reads best-effort from the local durable bus inbox: live envelopes
addressed to the node (`node.busAddress`, defaulting to `jobId`) or to `all`,
after the node's own `node.busAfter` cursor (default 0), newest first, within
the same byte budget. Notice lines carry kind `notice`, the `bus/<envelope-id>`
citation, sender, channel and time; message bodies stay inside the delimited
`text` field as untrusted data. A missing or unreadable bus adds nothing and
never fails the build.

## Other existing graph APIs

`buildFleetGraph` in [fleet/graph.ts](../src/core/fleet/graph.ts), exposed as
`phm fleet graph`, reads a separate router queue topology with leader, lane,
slot, job, PR and resource nodes. Its `contains`, `runs` and `produces` edges
represent observed topology, not a task prerequisite DAG or a source of pack
records. Its source statuses can be unknown or partial.

For an explicitly authored planning DAG, [mission-graph.ts](../src/core/vision/mission-graph.ts)
provides `compileEcosystemMissionGraph`, `validateEcosystemMissionGraph` and
`projectEcosystemMissionGraph`: nodes carry `dependsOn` keys, and projection
uses caller-supplied observations. It is bounded and planning-only; it does
not persist, dispatch, or fetch task outputs. Mission keys are not automatically
mapped to pack job IDs, and no integration here populates a context snapshot
from the mission graph. Resolve and verify any mapping in the calling system.

For code lookup, search the actual checkout, for example:

```sh
rg -n 'buildNodeContextPack' src test
# or: grep -R -n 'buildNodeContextPack' src test
```

The context pack performs lexical matching on supplied task/output text; it
does not index or vectorize the codebase.
