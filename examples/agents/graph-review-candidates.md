# List incoming review relationships for an agent

From the repository root, read the graph and list agents that review a target agent:

```sh
npx tsx examples/agents/graph-review-candidates.ts --agent fake-worker-a [--exclude-agent fake-worker-b]
```

`--agent` is required; `--exclude-agent` is optional and may be repeated to remove reviewers from results. The single JSON object on stdout has `schemaVersion: 1` and `status` (`ready`, `not_found`, `unavailable`, or `error`). Ready results include `agentId`, `reviewers: [{ reviewerId, edgeIds }]` in graph edge order, and `complete`, `sources`, `issues` (null when unknown). When exclusions are provided, results also include `excludedAgentIds` and `excludedCandidateCount`. An unknown agent returns `not_found`; an unavailable graph returns `unavailable`. Errors report `error: { code, message }` with codes `GRAPH_NODE_NOT_FOUND`, `GRAPH_UNAVAILABLE`, `GRAPH_LOAD_FAILED`, and `GRAPH_USAGE`.

Exit codes: `0` for `ready`, `1` for `not_found` / `unavailable` / `GRAPH_LOAD_FAILED`, and `2` for `GRAPH_USAGE`. Failures print a JSON object on stdout with the error status.
