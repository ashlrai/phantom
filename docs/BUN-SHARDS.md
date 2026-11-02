# Duration-balanced Bun shards

`scripts/bun-shards.mjs` plans explicit Bun test inventories using the existing
longest-processing-time-first allocator. It does not change CI workflows or
the Vitest backend runner. Workflow adoption needs a separate G1 change.

Create an inventory JSON array of repository-relative Bun test paths, for example
`["test/example.test.ts", "test/other.spec.ts"]`. Supply the same complete
inventory to each shard planner, from the same checkout and timings snapshot.
Only include tests compatible with Bun; this script does not convert Vitest tests.

```sh
node scripts/bun-shards.mjs plan inventory.json bun-timings.json 4 > shard-plan.json
HOME=$(mktemp -d) node scripts/bun-shards.mjs record inventory.json bun-timings.json
```

`plan` prints JSON with one-based shard indices, sorted file lists, total weights,
and fallback files. Consume each file list as separate argv entries prefixed
with `./` when invoking `bun test`; do not join paths into shell code. Empty
shards must exit successfully without invoking Bun (which would run all tests).
Every inventory file appears exactly once, including files absent from timings.
Inventory paths must resolve to regular test files within the current directory;
duplicates and symlink escapes are rejected.

`record` runs each file separately with `bun test ./path`, inherits test output,
and records elapsed wall-clock milliseconds including Bun startup. Each file has
a five-minute timeout. Any failure, signal, timeout, or missing executable stops
calibration without replacing the previous timings. A passing complete inventory
atomically replaces the snapshot, removing stale entries. Use separate output
paths for concurrent recorders; record on representative hardware with the same
Bun version and test configuration used by consumers. Isolate HOME as above.
The timings format is `{ "schema": "phantom-bun-timings/v1", "files": { "test/example.test.ts": 125 } }`.

Missing timings use file size, calibrated to aggregate observed milliseconds per
byte when measurements exist. A missing snapshot is a normal cold start; malformed
snapshots fail visibly. Cold plans report `bytes`; calibrated plans report
`estimated-ms`. Size is a heuristic, and a single dominant file can prevent tight
balance. The fixture test requires the maximum-minus-minimum shard load to stay
within 15% of the mean for 2, 3, 4, and 6 shards. This is a planning guarantee on
those fixtures, not a claim that PR CI already meets the 75-second target.

Regression checks:

```sh
HOME=$(mktemp -d) npm run test:ci -- test/bun-shards.test.ts test/test-shard-plan.test.ts
```
