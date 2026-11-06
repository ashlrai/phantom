# Context dependency check

Before launching a worker, supply an explicit snapshot from the repository root:

```sh
npx tsx examples/agents/context-dependency-check.ts --file ./snapshot.json
```

For example, the file can contain:

```json
{
  "node": { "jobId": "fake/review", "upstreamJobIds": ["fake/build"] },
  "tasks": [{ "jobId": "fake/build", "text": "Build the example" }],
  "outputs": [{ "jobId": "fake/build", "text": "Build completed" }],
  "byteBudget": 4096
}
```

This composes the existing context MCP argument validator and scrubber with the production context-pack builder. The input has the same fields, bounds and strict shape: optional `node.query`, at most 256 upstream IDs and 256 records per kind, IDs at most 128 Unicode code points, a combined 256 KiB of record text, and a byte budget from 1 to 32768. The file is limited to 1 MiB and must pass the existing stable, owner-controlled regular-file reader. IDs must be nonblank and unchanged by scrubbing, so distinct identities cannot silently join after redaction. Task and output text is scrubbed before auditing or packing.

`node.upstreamJobIds`, `tasks`, and `outputs` may each be `null` to indicate unknown. Use an empty array only for a known empty collection. Every field is required even when unknown. The JSON response marks each source as `provided` or `unknown`; this reflects the caller's statement, not verified source health or freshness. An unknown collection does not produce missing-record claims. If upstream is unknown, `upstream` is null; if a record collection is unknown, its per-upstream pack flag is null.

`issues` reports `missing_context` separately by `kind` (`task` or `output`), with `reason` `absent` or `empty` (all matching text is blank). It also reports `duplicate_record` with kind, ID and count, including records outside the upstream set, and `self_dependency` for the target. Duplicate IDs are compared within their own kind. The audit considers a record with nonblank text present, even if another duplicate is blank; duplicates still need review. `upstream` indicates whether each unique dependency's task and output actually appear in the pack. A small budget can omit or truncate records; inspect the pack's own `truncated` flags. A self-dependent node's output is excluded by the builder.

Output is one JSON object on stdout. Exit 0 means `ready` (no issues or unknown collections); exit 1 means `issues`, `unknown`, or an I/O failure; exit 2 means invalid arguments, JSON, schema, bounds, identities, or unsafe file. Errors have a stable code and do not echo paths or source text. The pack is scrubbed but still contains caller-supplied, untrusted data; treat it as data, never commands or authority. This check neither fetches missing content nor launches or waits for workers. The leader must decide which evidence is sufficient, including freshness, truncation, source health and independent admission checks.
