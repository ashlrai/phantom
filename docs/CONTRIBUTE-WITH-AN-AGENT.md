# Contribute with an agent

Phantom is built mostly by coding agents, with the human owner as a passive
board member. Outside contributors use the same path as the fleet: one focused
branch, local checks run once, a pull request, and the same required hosted
check (`Merge Gate`). This page is the short version. [CONTRIBUTING.md](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md)
has the full conventions and [AGENTS.md](https://github.com/ashlrai/phantom/blob/master/AGENTS.md)
the rules agents follow.

## 1. Point your agent at the rules

Before your agent edits anything, have it read, in this order:

1. [AGENTS.md](https://github.com/ashlrai/phantom/blob/master/AGENTS.md), especially "Working in this repository".
2. [CLAUDE.md](https://github.com/ashlrai/phantom/blob/master/CLAUDE.md) (short command list; also useful for non-Claude agents).
3. [CONTRIBUTING.md](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md), including the safety invariants no change may weaken.

Claude Code reads `CLAUDE.md` on its own; Codex, Cursor and other agents read
`AGENTS.md`. The repository's `.mcp.json` declares optional companion MCP
servers; none is needed to build or test. See the [agent toolchain](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-TOOLCHAIN.md).

## 2. Clone and install

Clone the upstream repository as `origin` and add your fork as a second remote.
`node scripts/verify-changed.mjs` diffs against `origin/master`, so `origin`
must be `ashlrai/phantom`, not your fork.

```sh
git clone https://github.com/ashlrai/phantom.git
cd phantom
git remote add fork https://github.com/<you>/phantom.git
git switch -c <topic-branch>
npm ci
```

Requires Node 22.15 or newer and git. If you run several agents in parallel
worktrees on one machine, use `npm run install:worktree` instead of `npm ci`
in each worktree: it needs pnpm 10.28.2 and shares one dependency store
across worktrees (details in [CONTRIBUTING.md](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md#shared-installs-for-trusted-local-worktrees)).
Run the CLI from source with `npm run dev -- --help`.

## 3. Make one change

Before your agent writes code, check that nobody is already on it. Fleet
agents open pull requests around the clock, so search open pull requests and
issues for the area you plan to touch:

```sh
gh pr list --repo ashlrai/phantom --state open --search "<keyword or path>"
gh issue list --repo ashlrai/phantom --state open --search "<keyword>"
```

For a bug fix or a small docs change, go straight to a pull request. For a new
feature or a larger change, open an issue first with the feature request or bug
report template so the direction is agreed before the work. Report security
problems privately as [SECURITY.md](https://github.com/ashlrai/phantom/blob/master/SECURITY.md)
describes, never in a public issue or pull request. If the change lands on a
protected path, it waits for the owner's review; see
[Protected paths wait for the owner](#protected-paths-wait-for-the-owner).

- One coherent outcome per pull request. Keep the diff reviewable.
- `src/cli/` handlers stay thin; logic goes in `src/core/`. Relative imports end in `.js`.
- Changing an exported signature means updating `CONTRACT.md` or the matching
  `docs/contracts/CONTRACT-M<N>.md` in the same change.
- Tests are hermetic: temp directories and fixtures, never your real home
  directory or a real model endpoint.
- No secret values, tokens or personal absolute paths anywhere.
- No new runtime dependency without updating the dependency boundary in CONTRIBUTING.md.

## 4. Verify locally, once

Run these in the foreground and wait for each to finish:

```sh
node scripts/verify-changed.mjs           # lint of changed files, one type check, docs check when docs/deletions changed, quarantine check when tests/ledger changed, syntax check of changed files by type (table below)
npm run test:ci -- test/<file>.test.ts    # affected backend suites, isolated HOME
npm run test:web                          # only if src/web-ui/ changed
npm run check:docs                        # if docs changed (verify-changed already ran it when the diff touched markdown or deleted files)
npx vitest run test/doc-facts.test.ts     # if a documented command, flag or npm script changed
npm run build                             # before suites that run dist/ (below), or if build, packaging or CLI wiring changed
npm run dev -- verify-safety              # if safety-relevant code changed; read-only, changes nothing
```

Some backend suites test the compiled CLI in `dist/`, not `src/`: they import
`test/helpers/require-built-dist.ts` or spawn `dist/cli/index.js`, and stop
with "run npm run build first" (or a similar message) when `dist/` is
missing. Run `npm run build` before them, and again after each source change,
or they test stale output. The fast gate leaves suites that import the helper
to the scheduled `master` run, so a green pull request does not cover them.

These match the "How it was verified" checklist in the pull request template
(`phm verify-safety` there is the installed form of the last line), so tick
what you ran and say what you skipped.

`verify-changed` records a pass for the current tree, so a repeat run on an
unchanged tree prints `SKIP verify-changed`; pass `--force` to rerun.
[docs/verify-changed.md](verify-changed.md) is the full reference: each step
in order, the environment variables, the pass record and the type-check slots
shared across worktrees.
`npm run gate` runs the build, static checks and related tests together if you
prefer one command. If authority drift fails, run `npm run authority:regen` and
list each new Tier-1 root in the pull request body.

If you added, renamed or deleted a page under `docs/`, or changed a page's
`#` title or first sentence, run `node scripts/generate-docs-llms.mjs` and
commit the updated `docs/llms.txt`. Its page index lists each page's title and
first sentence, and the required `Check generated files` job reruns the
generator and fails if any tracked file changes. If you changed `bin/ashlr`,
commit it, then run `npm run canonical-launcher-digests:regen` (it reads the
launcher's git history) and commit `scripts/canonical-launcher-digests.json`.
`npm run docs:sync` regenerates every generated surface (version blocks, site
pages, CODEMAP, the CLI references) and can also rewrite files you did not
touch; keep only the output your change caused.

### Reading `verify-changed` output

`verify-changed` prints one `PASS`, `SKIP`, `WARN` or `FAIL` line per step.
The first four steps stop the run when they fail; the rest all run and the
exit code is non-zero if any of them failed.

| Step | Runs when | If it fails |
| --- | --- | --- |
| File selection | Always | Without a merge base with `origin/master` (missing remote branch or shallow clone) it prints `WARN no merge base` and checks only uncommitted changes against `HEAD`, so committed work goes unchecked. Run `git fetch origin master`, or `git fetch --unshallow origin` in a shallow clone, then `node scripts/verify-changed.mjs --force`. |
| Empty test check | Always | Every new test file needs at least one test. |
| Fleet registry | A `src/cli/fleet-*.ts` file changed | Run `node scripts/gen-fleet-registry.mjs` and commit the result. |
| Authority drift | The diff touches `src/`, `test/`, `scripts/` or `.github/CODEOWNERS` | Review the drift, run `npm run authority:regen` and list each new Tier-1 root in the pull request body. When `origin/master` changed drift-relevant paths since you branched, the step reruns as `authority drift on current master` on your changed files laid over `origin/master`; if that fails, rebase onto `origin/master`, then regenerate. |
| Docs check | A markdown file changed or a path was deleted | Fix the link or anchor it reports. |
| ESLint | A JavaScript or TypeScript file changed | Fix the reported lines. |
| Python syntax check | A `.py` file or an extensionless script with a python shebang changed | Fix the reported `SyntaxError`. The files are compiled with `python3` without writing bytecode; with no working `python3` the step prints `SKIP`. |
| Shell syntax check | A `.sh` file or an extensionless script with a `sh`/`bash`/`dash` shebang changed | Fix the parse error `bash -n` reports. With no working `bash` the step prints `SKIP`. |
| Perl syntax check | A `.pl` file or an extensionless script with a `perl` shebang changed | Fix the compile error `perl -c` reports; `perl -c` compiles the script without running its body — the same check CI's secret-shape job applies to `scrub.pl`. With no working `perl` the step prints `SKIP`. |
| PowerShell syntax check | A `.ps1`, `.psm1` or `.psd1` file changed | Fix the `path:line:column` parse error `System.Management.Automation.Language.Parser.ParseFile` reports — parse only, the script never executes (this covers `scripts/install.ps1`, the shipped Windows installer). `pwsh` is probed first, then `powershell`; with neither host the step prints `SKIP`. |
| Node syntax check | An extensionless script with a `node` shebang changed | Fix the parse error `node --check` reports; launchers like `bin/ashlr` carry no extension, so the shebang decides. The check runs under the same node runtime, so it never prints `SKIP`. |
| Detached script syntax check | A script file under `src/raycast/` or `examples/universe-site/` changed | Fix the `path:line:column` parse error the bundled `typescript` parser reports; those trees own their toolchains, so ESLint and the root type check never read them. With no installed `typescript` package the step prints `SKIP`. |
| JSON syntax check | A `.json`, `.webmanifest` or `.tsbuildinfo` file changed | Fix the parse error `JSON.parse` reports; every failing file is named. The check needs no external tool, so it never prints `SKIP` for a changed `.json`, `.webmanifest` or `.tsbuildinfo` file. |
| JSONL syntax check | A `.jsonl` file changed | Fix the parse error `JSON.parse` reports on the named `file:line`; each non-blank line must be one complete JSON value and blank lines carry no record. The check needs no external tool, so it never prints `SKIP`. |
| XML syntax check | A `.xml`, `.plist`, `.plist.in` or `.svg` file changed | Fix the parse error `xml.etree.ElementTree` reports. Binary and ASCII `.plist` encodings skip the parser (`.plist.in` launchd templates always parse); with no working `python3` the step prints `SKIP`. |
| Rust syntax check | A `.rs` file changed | Fix the parse error `rustfmt` reports; with no working `rustfmt` the step prints `SKIP`. |
| Swift syntax check | A `.swift` file changed | Fix the parse error `swiftc -parse` reports; with no working `swiftc` the step prints `SKIP`. |
| YAML syntax check | A `.yml` or `.yaml` file changed | Fix the parse error the bundled `yaml` package reports; every document of a multi-document file is checked and duplicate keys are errors. With no installed `yaml` package the step prints `SKIP`. |
| TOML syntax check | A `.toml` file or a `Cargo.lock` manifest at any depth changed | Fix the parse error the bundled `smol-toml` package reports; `Cargo.lock` is TOML, e.g. `desktop/src-tauri/Cargo.lock`. With no installed `smol-toml` package the step prints `SKIP`. |
| CSS syntax check | A `.css` file changed | Fix the `path:line:column` parse error `lightningcss` reports; it is the CSS parser Vite bundles for the web-ui build, so it applies the grammar the build does. When vite or `lightningcss` cannot be resolved under `node_modules`, the step prints `SKIP`. |
| Snapshot syntax check | A Vitest `.snap` file changed | Fix the `path:line` parse error node's script parser reports, often a hand edit or a leftover merge-conflict marker; ESLint and the type check never read `.snap` files. The parser runs in-process, so the step never prints `SKIP`. |
| Patch syntax check | A `.patch` or `.diff` file changed | Fix the parse error `git apply --stat` reports; it checks the unified-diff grammar without requiring the patch to apply in this checkout, so staged proposals against other revisions still verify. Git is already required to collect the changed set, so the step never prints `SKIP`. |
| HTML payload syntax check | A `.html` or `.htm` file outside `test/fixtures/` changed | Fix the parse error reported for the named file and embedded block — an inline `<script>` (classic or `type="module"`), a JSON script type (`ld+json`, `importmap`, `speculationrules`, `+json`) or a `<style>` rule. External `src` scripts, inert `type` values, empty bodies and `<noscript>` scripts are skipped and `<template>` content is checked. With no installed `jsdom` package the step prints `SKIP`; `<style>` payloads warn-skip when `lightningcss` cannot be resolved through vite. |
| Conflict marker check | Any changed file still on disk | A `path:line: <marker>` hit means a line starts with a git conflict marker (`<<<<<<<`, `|||||||` or `>>>>>>>`); finish the resolution and delete the leftover marker lines. Only column 0 counts — markers inside strings, comments, docstrings or indented examples are content, not leftovers — and binary files plus `test/fixtures/` payloads (which may legitimately embed marker text as test input) are exempt. The check needs no external tool, so it never prints `SKIP`. |
| Quarantine ledger | A `*.test.*` or `*.spec.*` file or `queue/quarantine.tsv` changed | An added skip marker or `.only`, or a stale or expired ledger row; see [Skipping a flaky test](#skipping-a-flaky-test). |
| Real-I/O lane lint | Always | A changed test that spawns processes or does real I/O must be listed in `test/config/realio-lane-membership.mjs` (a protected path), or carry a comment near the match saying why it is safe in the fast lane. Files you did not change only print a `WARN`. |
| Verse sync-I/O lint | Always | No new synchronous filesystem or child-process call in a Verse route file (`src/core/verse/**/*-api.ts`) unless a `// sync-io-ok: <reason>` comment explains it. |
| Contrib router type check | A `.ts` file under `contrib/router/`, `src/core/authority/protected-paths.ts`, or `package.json`/`package-lock.json` changed | Fix the `path:line:col` type errors the documented `tsc --noEmit` run reports; the router executes under `tsx`, which transpiles without checking types, and no `tsconfig` project covers the tree. With no installed `typescript` package the step prints `SKIP`. |
| Type check | Backend project when the diff touches a root `tsconfig*.json`, `src/` (outside `src/web-ui/` and `src/raycast/`), `test/` or `scripts/`; web project when it touches `src/web-ui/`; both when `package.json` or `package-lock.json` changed. Docs-only diffs skip it. Runs incrementally with `tsgo`, falling back to `tsc` | Fix the reported errors. With many parallel worktrees, `FAIL tsc slot wait` means no type-check slot freed in time (`PHANTOM_TSC_TIMEOUT_SECONDS`, default 900). |

`SKIP eslint`, `SKIP docs check` or `SKIP css syntax check` with "run npm ci to restore it" means the
install is incomplete; run `npm ci` and then `node scripts/verify-changed.mjs --force`.
Do not rely on the "Merge Gate lints on CI" hint in that line: on a pull
request Merge Gate runs no ESLint (see step 6), so a skipped local lint means
the change merges unlinted.

### Skipping a flaky test

A test may be silenced only through the quarantine ledger,
`queue/quarantine.tsv`. Every `.skip`, `.todo` or `x`-prefixed marker your
diff adds needs a live row there: four tab-separated columns (`test`, `repo`,
`lead`, `expiry`), where `test` is the file or `<file> > <full test name>` and
`expiry` is at most seven days out. Remove the row and the marker together.
The verifier also refuses an added `.only`, a skip on a test that was never
running (quarantine retires a running test; it does not land a disabled one),
and any row that no longer covers a marker. The file header and
`scripts/check-quarantine-ledger.mjs` list every rule.

`verify-changed` and `npm run gate` run this check; the hosted `Merge Gate`
does not, so run it yourself when you skip a test:

```sh
npm run check:quarantine -- --base origin/master
```

## 5. Push to your fork and open the pull request

```sh
git push fork <topic-branch>
gh pr create --repo ashlrai/phantom --base master --head <you>:<topic-branch>
```

Fill in the [pull request template](https://github.com/ashlrai/phantom/blob/master/.github/PULL_REQUEST_TEMPLATE.md):
what changed, the exact commands you ran, and anything you skipped. Nobody
pushes directly to `master`. Pull requests land as squash commits, so your pull
request title becomes the commit subject on `master`; give it a conventional
type prefix such as `fix:` or `docs:` so release-please files it under the
right `CHANGELOG.md` section (see
[Commit style](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md#commit-style)).

Fleet agents push only to forks as well. Their publisher pushes a
`codex-bridge/<job>` branch, opens the pull request titled
`bridge(<job>): <subject>` (the subjects you see in `git log`), and arms
auto-merge with `gh pr merge --auto --squash --match-head-commit <sha>`. If a
publish pushed the branch but stopped before opening the pull request,
`phm publish orphans` lists such branches from the last 48 hours and
`phm publish resume --branch <job>` finishes the job. Both act only on
`codex-bridge/` branches of the signed-in user's own fork, for the seven
ecosystem repositories.

## 6. What CI requires

`Merge Gate` is the single required check. On a pull request it passes only
when these jobs succeed:

| Job | What it checks |
| --- | --- |
| Secret-shape scan | Added lines contain nothing token-shaped outside fake test fixtures. |
| Secret scan (diff) | A second secret scan over the diff. |
| Classify | Picks the lane (site, docs or full) for the change. |
| Check generated files | `node scripts/generate-docs-llms.mjs` leaves every tracked file unchanged, and the `bin/ashlr` digest is listed in `scripts/canonical-launcher-digests.json`. |
| Fast gate (typecheck + affected tests) | Type check plus a bounded set of tests selected from your diff (below). |

Quick typecheck and `Check authority drift (hermetic)` also run but are
advisory. The full backend, Windows and macOS
suites, `npm run lint` and `npm run check:docs` do not run on pull requests;
they run on the six-hour scheduled
`master` run, and failures there are fixed forward. Read the actual check run
for your commit; a workflow file is not evidence that it passed. GitHub may
ask a maintainer to approve workflow runs for a first-time contributor.

### Which tests the fast gate runs

`.github/scripts/ci-fast-select.mjs` picks the tests from the changed paths,
and the fast gate never skips tests silently:

- **Docs-only diff** (every path is under `docs/` or ends in `.md`):
  `test/docs-repo-links.test.ts` always runs, plus each test whose source
  names a changed file by its path or its bare file name, even in a comment,
  up to the same related cap. A page no test names runs only the link suite; a
  docs-only diff never takes the fallback set below.
- **Code diff, fresh graph**: the dependency graph for this commit
  (schema `phantom-dep-graph.v1`, `commit` equal to `HEAD` or an ancestor of
  the base, blob hashes matching) selects tests by transitive reverse-import
  reachability, nearest first, up to the related cap in
  `.github/fast-gate-budget.json` (25 in the measured file). Name-matched
  `test/**/<stem>.test.ts` files fill in after that closure. A web test that
  reaches a changed file, and the colocated `src/web-ui/**/*.test.ts` or
  `*.test.tsx` for a changed web file, run under `vitest.config.web.ts`
  (`npm run test:web -- <files>`). Changed test files always run. Named tests:
  - `.github/CODEOWNERS`, `src/core/authority/`, a `test/authority-*310b*`
    suite or `.github/tests/secret-shape/` adds the two
    `test/authority-*-310b.test.ts` suites.
  - A file in the recorded Tier-1 import closure
    (`test/fixtures/authority/tier1-closure.json`), that snapshot itself, or a
    new file under a closure root such as `src/core/memory/` or
    `src/core/routing/` adds `test/authority-tier1-closure-310b.test.ts`.
  - `src/cli/index.ts`, `src/cli/help.ts` or `src/cli/completions.ts` adds
    `test/cli-registry-drift.test.ts`.
  - `.github/workflows/ci.yml` adds `test/m30.ci.test.ts`.
  - A changed `.github/scripts/<name>.mjs` adds its
    `.github/tests/<name>.test.mjs`.
  A changed `.github/tests/secret-shape/` path is one of the Tier-1 paths
  above, so those two authority suites stay in the selection. The
  secret-shape scan itself is a separate required job and is not selected
  here.
- **No importers**: a changed source the fresh graph shows with no importers
  and no colocated test runs the versioned smoke set in
  `.github/fast-gate-smoke.json` (`phantom-fast-gate-smoke.v1`) instead
  of a stride sample. The two Tier-1 authority suites are always in that set.
- **Fallback**: a change to `package.json` or `package-lock.json`, a
  `tsconfig*.json`, a Vite or Vitest config, `test/setup/`, `test/config/` or
  `scripts/test-ci*.mjs`, a missing, unparsable, or stale graph (its `commit`
  is not `HEAD` and not an ancestor of the base), a changed file with a
  dynamic import or other specifier the graph cannot resolve, a docs diff
  that maps to no test, or a selection error runs an even spread of the
  fallback budget in `.github/fast-gate-budget.json` (three shards of 40 in
  the measured file) that always
  includes the two authority suites. A `package.json` change also adds
  `test/package-files-allowlist.test.ts`. Uncertain inputs run this broader
  set, never a smaller one.

Tests that need the built `dist/`, and the slow real-I/O and serial suites
picked up indirectly, are left to the scheduled `master` run. `npm run check:docs` is not part of the pull request
gate, so run it yourself whenever you touch markdown.

To see the plan for your branch, commit and run:

```sh
graph="$(mktemp)"
node .github/scripts/ci-dep-graph.mjs update --out "$graph"
RUNNER_TEMP="$(mktemp -d)" CI_DEP_GRAPH="$graph" \
  ASHLR_CI_BASE_SHA="$(git rev-parse origin/master)" \
  ASHLR_CI_HEAD_SHA="$(git rev-parse HEAD)" \
  node .github/scripts/ci-fast-select.mjs
```

It prints the mode and test counts and writes the list to
`$RUNNER_TEMP/fast-gate-plan.json`. Run the vitest files with
`npm run test:ci -- <files>` and any `src/web-ui` tests with
`npm run test:web -- <files>` before you push.

## 7. Auto-merge

The repository merges through GitHub's merge queue with auto-merge. Agents with
write access arm it with `gh pr merge --auto`; from a fork you cannot, so a
maintainer or fleet agent arms it for you. Once armed, the pull request merges
as soon as `Merge Gate` passes in the queue, with no separate manual merge
step. Being behind `master` is fine: the queue tests your change merged onto
the current base. If `master` moves and your branch conflicts, rebase onto
`origin/master`, rerun the checks in step 4, and push again.

### When a check fails for a reason outside your change

If `Merge Gate` or the fast gate fails and `master`'s own run of that check
is red too, the failure is probably not yours. For pull requests whose branch
lives in `ashlrai/phantom` itself, the scheduled `Unrelated PR recovery`
workflow (`.github/scripts/ci-unrelated-recover.mjs`) reruns the failed jobs
once per head commit when auto-merge is armed. It skips pull requests from
forks, drafts, and failures in the secret scans or `Check generated files`.
From a fork, wait until `master` is green again, then rebase onto
`origin/master` and push, or ask a maintainer to rerun the failed jobs.

Other workflows you may see around your pull request are not required and
do not block auto-merge:

- `Perf budget (advisory, non-required)` runs when a pull request is opened,
  reopened or marked ready, not on later pushes. It times the cold CLI paths
  in `perf/budgets.json` and fails when a median exceeds its baseline plus
  the file's tolerance (20% unless a target sets its own). A red result means your change may have slowed startup, or the
  shared runner was slow; look before you dismiss it.
- `Dependency audit (root + Raycast)` runs only when a manifest, lockfile or
  audit configuration changes. Dependency manifests and lockfiles are protected;
  other audit inputs need not be. See
  [docs/DEPENDENCY-SECURITY.md](DEPENDENCY-SECURITY.md).
- `PR topology observation (non-authoritative)` is telemetry, and the
  `Merge Queue Reaper` only cancels queue runs whose queue entry is gone.

### Protected paths wait for the owner

A passing `Merge Gate` is enough only when the diff stays off the protected
(Tier-1) paths. [`.github/CODEOWNERS`](https://github.com/ashlrai/phantom/blob/master/.github/CODEOWNERS)
assigns those paths to the repository owner and GitHub requires the owner's
review on them, so a pull request that touches one waits for that review even
with auto-merge armed. Fleet agents follow the same rule; the fleet's GitHub
App is never a code owner. The protected set includes:

- CI configuration (`.github/**`) and `CODEOWNERS` itself.
- Manifests and lockfiles (every `package.json`, `pnpm-lock.yaml` and similar),
  so any new or changed dependency needs the owner.
- Build, hook and verify configuration (`tsconfig*.json`, `Dockerfile`,
  `Makefile`, `.husky/**`) and release tooling (`scripts/release*`,
  `scripts/build*`).
- Test infrastructure (`test/setup/**`, `test/config/**`, `vitest.config*`) and
  the tests that guard Tier-1 code, listed by name.
- Authority code and docs (`src/core/authority/**`, `docs/**/*AUTHORITY*`),
  memory (`src/core/memory/**`), desktop custody and secret material.

The file is generated from `src/core/authority/protected-paths.ts`, so treat it
as the source of truth rather than this summary. Before you start, check
whether your change lands on a protected path:

```sh
grep -n "<path or directory>" .github/CODEOWNERS
```

If it does, keep the change and say in the pull request body why it needs the
protected path, or split it so the unprotected part can merge on its own.
Never edit `CODEOWNERS` by hand: `npm run authority:regen` regenerates it, and
`test/authority-codeowners-310b.test.ts` fails on drift.

Nothing in this flow weakens a test, bypasses a ruleset or uses an admin
override; changes that try are refused. See the
[safety invariants](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md#safety-invariants-contributors-must-never-weaken).

## 8. The other ecosystem repositories

Phantom is one of seven repositories the fleet works on. Each of the other six
is a separate repository with its own `CONTRIBUTING.md` (setup, tests, checks)
and `AGENTS.md` (agent rules). Point your agent at those two files first, the
same way as step 1. The default branch of each is `main`, not `master`, so open
pull requests with `--base main`.

| Repository | What it is | Read first |
| --- | --- | --- |
| [phantom-secrets](https://github.com/ashlrai/phantom-secrets) | Local vault, placeholders and a proxy for supported API credential use. | [CONTRIBUTING.md](https://github.com/ashlrai/phantom-secrets/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/ashlrai/phantom-secrets/blob/main/AGENTS.md) |
| [locus](https://github.com/ashlrai/locus) | Account and tenant bindings for agent tools. | [CONTRIBUTING.md](https://github.com/ashlrai/locus/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/ashlrai/locus/blob/main/AGENTS.md) |
| [ashlr-plugin](https://github.com/ashlrai/ashlr-plugin) | Compact tool results and a local usage ledger. | [CONTRIBUTING.md](https://github.com/ashlrai/ashlr-plugin/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/ashlrai/ashlr-plugin/blob/main/AGENTS.md) |
| [lexicon](https://github.com/ashlrai/lexicon) | Correct recurring speech-to-text errors before agents read them. | [CONTRIBUTING.md](https://github.com/ashlrai/lexicon/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/ashlrai/lexicon/blob/main/AGENTS.md) |
| [ashlr-md](https://github.com/ashlrai/ashlr-md) | Markdown editing with CLI and MCP interfaces. | [CONTRIBUTING.md](https://github.com/ashlrai/ashlr-md/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/ashlrai/ashlr-md/blob/main/AGENTS.md) |
| [ashlr-stack](https://github.com/ashlrai/ashlr-stack) | Configure supported development services through CLI and MCP. | [CONTRIBUTING.md](https://github.com/ashlrai/ashlr-stack/blob/main/CONTRIBUTING.md), [AGENTS.md](https://github.com/ashlrai/ashlr-stack/blob/main/AGENTS.md) |

The shape of the work carries over: one focused branch pushed to your fork, the
repository's own checks run once, a pull request with a conventional title.
The specifics on this page do not: `scripts/verify-changed.mjs`, `npm run test:ci`,
the `Merge Gate` job list, the fast-gate selection and the protected-path list
belong to Phantom. Each repository's `CONTRIBUTING.md` has its own "contribute
with an agent" section. This table summarizes the parts that differ most:

| Repository | Toolchain | Check before you push | Required check |
| --- | --- | --- | --- |
| [phantom-secrets](https://github.com/ashlrai/phantom-secrets/blob/main/CONTRIBUTING.md#contribute-with-an-agent) | Rust (pinned by `rust-toolchain.toml`), Node.js, Perl | `scripts/fast-check.sh upstream/main`, then the full Cargo test, fmt and clippy gate (pull request CI does not run the Rust tests) | `CI Gate` |
| [locus](https://github.com/ashlrai/locus/blob/main/CONTRIBUTING.md#contribute-with-an-agent) | Rust stable | `bash scripts/fast-check.sh` | `CI Gate` |
| [ashlr-plugin](https://github.com/ashlrai/ashlr-plugin/blob/main/CONTRIBUTING.md#contribute-from-a-fork-with-your-own-agent) | Bun 1.4.4 or newer, Node.js | `bun scripts/premerge-local.ts upstream/main`, plus the secret-shape scan | `CI Gate` |
| [lexicon](https://github.com/ashlrai/lexicon/blob/main/CONTRIBUTING.md#contribute-with-an-agent) | Node.js 20 or newer | its `typecheck`, `build` and `check:crypto` npm scripts, then `npm test` | `CI Gate` |
| [ashlr-md](https://github.com/ashlrai/ashlr-md/blob/main/CONTRIBUTING.md#contribute-with-an-agent) | Rust, Bun, Node.js, Python 3, Perl | `scripts/ci-local.sh upstream/main`, plus the fast-job steps it skips | `Check (Linux)` |
| [ashlr-stack](https://github.com/ashlrai/ashlr-stack/blob/main/CONTRIBUTING.md#contribute-with-an-agent) | Bun 1.4.4 or newer, Node.js 20 or newer | `bash scripts/fast-check.sh` and `scripts/affected-tests origin/main` | `CI Gate` |

Two differences from Phantom trip agents up. First, the remotes are the other
way round: those guides clone your fork as `origin` and add `ashlrai/<repo>`
as `upstream`, so local checks compare against `upstream/main` (or a fork
`main` you keep in sync with it), not `origin/master` as in
[step 2](#2-clone-and-install). Follow each repository's own layout. Second,
GitHub lets only accounts with write access arm auto-merge, so on a fork pull
request a maintainer or fleet agent arms it once the required check is green.
Take each repository's exact commands, required checks and `CODEOWNERS` from
its own files; they win if this table is older. The fleet publisher and
`phm publish orphans`/`phm publish resume` cover all seven repositories.
