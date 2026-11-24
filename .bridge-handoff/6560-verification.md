# PR 6560 local merge verification

Outcome: blocked. Conflicts are resolved locally, but the existing authority
closure guard rejects six newly imported wiki modules. No commit, push, tag,
publication, remote mutation, or authority snapshot regeneration was performed.

PR head remains `e333a21b0af407a335a5f2081cbf1af6aca353b7`.
The pending merge incorporates master
`2c2008f2611078ca36c73abd92517b79db55f45f`.

The candidate preserves the PR's wiki brief CLI, origin-matched wiki context
for cloud tasks, and regression tests. The real-I/O membership conflict retains
both master's fleet-republish entry and the PR's wiki-brief entry. The generated
CLI reference was regenerated and is identical to master's version. The
authority closure snapshot, CODEOWNERS, and authority source files are exactly
master's bytes. The older doctor compiled-output prerequisite is already on
master, so it adds no unique diff.

Unique tracked diff against master: 10 files, 160 additions, 3 deletions,
net +157 lines. This note is not included in those numbers.

## Verification

| Check | Result |
| --- | --- |
| Required verify-changed | Failed at authority drift; 9 tests passed, 1 failed |
| Affected wiki/cloud suites | 3 files passed, 61 tests passed |
| Backend typecheck using package entry point | Passed |
| Web typecheck using package entry point | Passed |
| Changed-file ESLint | Passed |
| Documentation links | Passed: 281 local links, 469 source links, no errors |
| Generated CLI reference check | Passed |
| Scoped real-I/O lane guard | Passed; 28 unchanged master files reported as warnings |
| Full real-I/O lane guard | Failed on those 28 unchanged master files |
| Verse synchronous-I/O guard | Passed |
| Diff whitespace check | Passed |
| Unresolved conflict entries | None |

Authority failure lists:

- `src/core/knowledge/wiki/brief.ts`
- `src/core/knowledge/wiki/plan.ts`
- `src/core/knowledge/wiki/status.ts`
- `src/core/knowledge/wiki/steering.ts`
- `src/core/knowledge/wiki/store.ts`
- `src/core/knowledge/wiki/types.ts`

The new cloud-service import is the reason this closure grows. This task
prohibits editing authority baselines, closure allowlists, CODEOWNERS, and
authority source to make it pass, so the guard remains intact and failing.

The normal `npm run typecheck` invocation failed before compilation because
the shared dependency installation's relative `.bin/tsgo` shim does not resolve
from the temporary checkout. Calling the same installed package's entry point
directly passed for both compiler projects. Shared dependencies were not edited.

The one required verify-changed run examined 3273 paths because it uses the
old PR head's merge base, including the pending master merge. It has no `--base`
option. It stopped at authority drift, so downstream checks were run explicitly.

## Commands run

Every test invocation used a new temporary HOME. Builds, compilers and tests
used `nice -n 10`. Commands below omit only the working-directory argument.

```sh
task_docs_home=$(mktemp -d)
env HOME="$task_docs_home" nice -n 10 node scripts/docs-sync.mjs --only cli-reference --json
git add docs/CLI-REFERENCE.md test/config/realio-lane-membership.mjs test/fixtures/authority/tier1-closure.json

task_verify_home=$(mktemp -d)
env HOME="$task_verify_home" nice -n 10 node scripts/verify-changed.mjs

task_tests_home=$(mktemp -d)
env HOME="$task_tests_home" nice -n 10 npm run test:ci -- test/wiki-brief.test.ts test/cloud-service.test.ts test/cloud-delivery-contract.test.ts test/wiki.test.ts --maxWorkers=2

nice -n 10 npm run typecheck
nice -n 10 node node_modules/@typescript/native-preview/bin/tsgo --noEmit
nice -n 10 node node_modules/@typescript/native-preview/bin/tsgo --noEmit -p src/web-ui/tsconfig.json
nice -n 10 node node_modules/eslint/bin/eslint.js --no-warn-ignored -- src/cli/completions.ts src/cli/wiki.ts src/core/cloud/delivery-contract.ts src/core/cloud/service.ts src/core/knowledge/wiki/brief.ts src/core/knowledge/wiki/index.ts test/cloud-service.test.ts test/config/realio-lane-membership.mjs test/wiki-brief.test.ts
nice -n 10 npm run check:docs
nice -n 10 npm run lint:realio-lane
nice -n 10 npm run lint:verse-sync-io
nice -n 10 node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {runRealioCheck} from "./scripts/verify-changed.mjs"; const files = execFileSync("git", ["diff", "--name-only", "origin/master"], {encoding:"utf8"}).trim().split("\n"); process.exitCode = runRealioCheck(process.cwd(), files) ? 0 : 1;'
nice -n 10 node scripts/docs-sync.mjs --only cli-reference --check --json
git diff origin/master --check
git diff --name-only --diff-filter=U
git diff origin/master --numstat
git rev-parse HEAD
```

The `test/wiki.test.ts` filter matched no file; the affected-test runner
collected the three named existing suites and passed all 61 tests.

A source-CLI smoke invocation, using a disposable HOME and `wiki brief` on
an unenrolled temporary directory, returned exit 2 with the expected enrollment
refusal. It did not establish a successful enrolled CLI path. No enrollment was
created. No complete CI or publish readiness is claimed.

```sh
task_cli_home=$(mktemp -d)
env HOME="$task_cli_home" nice -n 10 node --import tsx src/cli/index.ts wiki brief "$task_cli_home" --json
```
