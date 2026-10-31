# Queue blockers

From the repository root, run:

```sh
npx tsx examples/agents/queue-blockers.ts
npx tsx examples/agents/queue-blockers.ts --lane codex-local
```

This read-only tool reads the current user's `~/.ashlr-runs/queue` using the fleet queue reader. It does not clear holds or modify files. The optional lane is an exact, case-sensitive match; an unknown lane produces an empty `groups` array.

Standard output is one JSON object: `v`, `generatedAt`, `sources` (`ready` and `skips`, each `healthy`, `missing`, or `degraded`), `total`, `ready`, `parked`, `malformed`, and `groups`. Counts and source health describe the entire original queue even when filtering by lane. `total` counts valid ready and parked jobs; `malformed` counts rejected ready rows separately. Groups are ranked by descending count, then reason and lane, and contain `reason`, `lane`, `count`, and `jobs`. The reader sorts IDs and returns at most eight per group; `count` remains the full group count. The reader's source bounds and validation still apply.

Exit code 0 means both sources are healthy, including an empty queue or no matching lane. Exit code 1 means a source is missing or degraded (JSON is still printed), or the reader failed unexpectedly (a generic error is printed to stderr). Exit code 2 means invalid arguments; usage is printed to stderr and no queue is read.
