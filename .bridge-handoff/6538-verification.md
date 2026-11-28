# PR 6538 local merge verification

Original head: `882b3a89f1c3cbd27f9a5c69238aa620f6f1b3ec`.
Pending master merge: `2c2008f2611078ca36c73abd92517b79db55f45f`.

The CLI, checker, data, original test and generated status document are
byte-identical to master, and the asks registry entry is present. Merged
PR [8184](https://github.com/ashlrai/phantom/pull/8184) carries that implementation.
The original six-line CONTRACT.md paragraph was omitted from the replacement.
The resolved candidate preserves all master content and appends that paragraph,
with one separating blank line: one unique file, +7/-0, net +7 lines.
The original PR is therefore not classified as fully superseded.

All changes remain uncommitted. HEAD is unchanged, MERGE_HEAD records the
master snapshot, and there are no unresolved conflict entries.

## Verification

- Nine affected and preservation suites: 67 passed, 0 failed.
- The asks suite within that run: 15 passed, 0 failed.
- Required verify-changed: failed on existing master problems and a temporary
  checkout dependency shim. It selected 3815 paths from the old merge base.
- Both authority checks passed in the candidate and current-master phases:
  10 tests in each phase, 20 passed, 0 failed across both executions.
- Documentation links passed with zero errors.
- Direct installed backend and web compiler entry points both passed.
- Whitespace and conflict checks passed.

The broad gate found 7 ESLint errors, 6 malformed JSONL fixtures, 23 quarantine
ledger violations and 28 real-I/O membership failures. Every affected file is
byte-identical to the pinned master snapshot; the only candidate delta is
CONTRACT.md. No unrelated test, fixture, lint rule or security control was edited.
The relative tsgo shim could not locate its package from the temporary clone;
the same installed package was then invoked directly for both projects.

An additional MobileShell baseline run was requested to diagnose PR 6547.
On unchanged master source it passed 9 tests and failed 7, including pending
lazy-screen loading. This is separate from the passing 67-test preservation run.

## Commands

Each test or gate invocation used a fresh temporary HOME. Checks used nice.

```sh
task_test_home=$(mktemp -d)
env HOME="$task_test_home" nice -n 10 npm run test:ci -- test/fleet-asks-n17a.test.ts test/recut-c404-corefleet.test.ts test/recut-corefleet-c482.test.ts test/recut-corefleet-c518.test.ts test/recut-corefleet-c539.test.ts test/fleet-empties-owner-qualification-521s.test.ts test/mcp/fleet-empties.test.ts test/fleet-empty-cause.test.ts test/fleet-empties.test.ts --maxWorkers=1 --no-file-parallelism

task_test_home=$(mktemp -d)
env HOME="$task_test_home" nice -n 10 node scripts/verify-changed.mjs

nice -n 10 node node_modules/@typescript/native-preview/bin/tsgo --noEmit
nice -n 10 node node_modules/@typescript/native-preview/bin/tsgo --noEmit -p src/web-ui/tsconfig.json

task_test_home=$(mktemp -d)
env HOME="$task_test_home" DEBUG_PRINT_LIMIT=0 nice -n 10 node node_modules/vitest/vitest.mjs run --config vitest.config.web.ts --maxWorkers=1 --no-file-parallelism src/web-ui/routes/verse/mobile/MobileShell.test.tsx

git diff --check origin/master
git diff --name-only --diff-filter=U
git diff origin/master --stat
git rev-parse HEAD MERGE_HEAD
```

The initial scripted paragraph placement failed an anchor assertion before
writing. The final resolution rebuilt CONTRACT.md from master's exact content
and appended only the original paragraph. Final conflict checks passed.
