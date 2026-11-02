# Hypothetical wave planning from a snapshot

From the repository root, read a bounded JSON snapshot and compute hypothetical dispatch waves:

```sh
npx tsx examples/agents/task-wave-plan.ts --file snapshot.json
```

`--file` is required and must point to a valid JSON snapshot (up to 2000 tasks). The single JSON object on stdout has `schema: 'task-wave-plan.v1'` and `status` (`ok` or `error`). Ready results include `waves: string[][]` (hypothetical waves), `maximumPotentialParallelism: number`, `unresolved: [{ id, missingExternalDependencies }]`, and `notice`. Errors report `error: <string>` with values `file-unavailable`, `file-too-large`, `invalid-json`, `invalid-snapshot`, `invalid-arguments`, and `duplicate-task-id`.

Exit codes: `0` for `ok`, `1` for `file-unavailable`, and `2` for all other error values. Failures print a JSON object with `error: <string>` on stdout.
