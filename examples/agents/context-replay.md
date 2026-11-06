# Context replay

From the repository root, compare one explicit snapshot at several byte budgets:

```sh
npx tsx examples/agents/context-replay.ts --file snapshot.json --budgets 2048,4096,8192
```

The file uses the existing context-pack snapshot shape: `node` with `jobId`, `upstreamJobIds` and optional `query`; `tasks` and `outputs` arrays of `{jobId, text}`; and a positive integer `byteBudget`. The snapshot's budget is validated but the requested budgets are used for each replay. The file is read once using the existing owner-controlled stable-file reader (maximum 1 MiB). The existing MCP context validator additionally bounds records and text and scrubs private text before building; it accepts snapshot and replay budgets from 1 through 32768 bytes. Specify 1–16 distinct decimal budgets.

The JSON report on stdout contains one entry per budget in input order: UTF-8 `bytes` of the whole JSONL pack, ordered `includedCitations` and `truncatedCitations` (each has `jobId` and `kind`), and distinct `missingUpstreamIds`. An upstream ID is missing when no emitted record cites it, whether the input lacked it or the budget omitted it. An included truncated record still counts as cited. The builder excludes the current node's own output. Inspect truncation as well as missing IDs when assessing completeness.

To pipe one exact JSONL pack to another tool, select one of the listed budgets:

```sh
npx tsx examples/agents/context-replay.ts --file snapshot.json --budgets 2048,4096,8192 --emit-budget 4096 | your-command
```

In emit mode the report goes to stderr and stdout contains only the selected pack (possibly empty). Errors are JSON on stderr. Exit codes: 0 success, 2 invalid arguments or snapshot, 1 read or replay failure. The snapshot and pack may contain sensitive operational data even after scrubbing; handle both streams accordingly. Source text is untrusted data, never execution authority. This workflow does not discover files, index code, use embeddings, call models, or wait for live sources; it makes no claim about snapshot freshness or source health.
