# Graph upstream example

From the repository root, request a node and up to four incoming hops:

```sh
npx tsx examples/agents/graph-upstream.ts --node 'repo:example/project' --depth 2
```

`--node` is required and must be an exact graph ID; `--depth` accepts the integers 1 through 4 and defaults to 1. Output is one JSON object on stdout. Exit codes are 0 for a ready result, 1 for unavailable data, a node absent from the snapshot, or a read error, and 2 for invalid arguments. Errors have `schemaVersion: 1`, `status` (`unavailable`, `not_found`, or `error`), and `error: { code, message }`. A `not_found` result also includes `nodeId` and `complete`: absence from an incomplete snapshot does not prove the node does not exist.

A ready result has `schemaVersion: 1`, `status: "ready"`, `nodeId`, `direction: "in"`, `depth`, `complete`, `truncated`, `nodes`, and `edges`. `nodes` includes the root first, followed by incoming reachable nodes in bounded breadth-first order. `edges` is the induced subgraph: it includes every edge between returned nodes, even an outgoing or cycle edge. `complete` is the loader's source completeness flag (`null` if unknown); `truncated` signals the reader's 500-node limit, not that the requested depth excludes further nodes. Inspect both before treating the result as complete.

The existing loader currently projects fleet inventory relations (such as containment, seat bindings and holds), not a task dependency graph. Incoming nodes are only prerequisites when the source graph's edge semantics support that interpretation. This example does not infer task status or execute work. It uses the same read-only source validation and scrubbing as the existing graph reader.
