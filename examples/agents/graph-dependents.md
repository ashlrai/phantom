# Graph dependents

From the repository root, run:

```sh
npx tsx examples/agents/graph-dependents.ts --node 'fleet:root' --depth 2
```

Both options are required; depth is an integer from 1 through 4. `--help` prints usage without reading inventory. The tool reads the existing public graph and follows outgoing edges; it does not index code, change data, or dispatch work. Interpret reached nodes as dependents only when edges in the source graph point from a prerequisite to its dependent. The current loader supplies fleet inventory relationships (contains, serves, binds, and holds), not task-dependency edges, so it cannot currently establish which tasks depend on an output.

Except for help, stdout contains one JSON object. On success it has `schemaVersion: 1`, `status: "ready"`, `nodeId`, `direction: "out"`, `depth`, `truncated`, `nodes`, and `edges`. Nodes include the starting node once, in breadth-first order; edges form the induced subgraph of reached nodes. `truncated` signals the reader's 500-node cap. `complete`, `sources`, and `issues` are copied from the loader (or `null` if unavailable); incomplete inventory or truncation means the result may omit relationships. The requested depth also bounds reachability. Source metadata can include the inventory path.

Errors are JSON with `schemaVersion: 1`, `status: "error"`, and `error` containing `code` and `message`. Exit code 0 means success or help, 1 means unavailable inventory (`GRAPH_UNAVAILABLE`), missing node (`GRAPH_NODE_NOT_FOUND`), or a read/validation failure (`GRAPH_LOAD_FAILED`), and 2 means invalid arguments (`GRAPH_USAGE`). Error messages do not expose reader exceptions.
