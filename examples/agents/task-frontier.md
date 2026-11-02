# Query ready tasks from a snapshot

From the repository root, read a bounded JSON snapshot and emit the ready-task frontier:

```sh
npx tsx examples/agents/task-frontier.ts --file snapshot.json
```

`--file` is required and must point to a valid JSON snapshot. The single JSON object on stdout has `schemaVersion: 1` and `status` (`ready` or `error`). Ready results include `readyIds`, `blockedIds`, `unknownCompletedIds`, and `unresolvedDependencyIds`. Errors report `error: { code, message }` with codes `DUPLICATE_TASK_ID`, `QUERY_FAILED`, `READ_FAILED`, `USAGE`, `INVALID_FILE`, `INVALID_JSON`, and `INVALID_SNAPSHOT`.

Exit codes: `0` for `ready`, `1` for `DUPLICATE_TASK_ID` / `QUERY_FAILED` / `READ_FAILED`, and `2` for `USAGE` / `INVALID_FILE` / `INVALID_JSON` / `INVALID_SNAPSHOT`. Failures print a JSON object with `error: { code, message }` on stdout.
