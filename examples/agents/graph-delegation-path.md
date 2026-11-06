# Find a delegation path through the graph

From the repository root, read the graph and find the delegation path from a source node to a destination:

```sh
npx tsx examples/agents/graph-delegation-path.ts --from fake-worker-a --to fake-worker-b [--avoid fake-worker-c]
```

`--from` and `--to` are required; `--avoid` is optional and may be repeated to exclude nodes from the path. The single JSON object on stdout has `schemaVersion: 1` and `status` (`ready`, `not_found`, `no_path`, `unavailable`, or `error`). Ready results include `from`, `to`, `nodeIds`, `edgeIds`, `avoidedNodeIds` (when provided), and `complete`, `sources`, `issues` (null when unknown). Missing nodes return `not_found` with `missingNodeIds`; no path returns `no_path`; an unavailable graph returns `unavailable`. Errors report `error: { code, message }` with codes `GRAPH_NODE_NOT_FOUND`, `GRAPH_NO_PATH`, `GRAPH_UNAVAILABLE`, `GRAPH_LOAD_FAILED`, and `GRAPH_USAGE`.

Exit codes: `0` for `ready`, `1` for `not_found` / `no_path` / `unavailable` / `GRAPH_LOAD_FAILED`, and `2` for `GRAPH_USAGE`. Failures print a JSON object on stdout with the error status.
