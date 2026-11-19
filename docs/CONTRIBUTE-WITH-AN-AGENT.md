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
node scripts/verify-changed.mjs           # lint of changed files, one type check, docs check when docs/deletions changed, quarantine check when tests/ledger changed
npm run test:ci -- test/<file>.test.ts    # affected backend suites, isolated HOME
npm run test:web                          # only if src/web-ui/ changed
npm run check:docs                        # if docs changed (verify-changed already ran it when the diff touched markdown or deleted files)
npx vitest run test/doc-facts.test.ts     # if a documented command, flag or npm script changed
```

`verify-changed` records a pass for the current tree, so a repeat run on an
unchanged tree prints `SKIP verify-changed`; pass `--force` to rerun.
`npm run gate` runs the build, static checks and related tests together if you
prefer one command. If authority drift fails, run `npm run authority:regen` and
list each new Tier-1 root in the pull request body.

If you added or renamed a document, run `npm run docs:sync` and commit what it
regenerates; the hosted generated-files check fails on a stale tree.

### Reading `verify-changed` output

`verify-changed` prints one `PASS`, `SKIP`, `WARN` or `FAIL` line per step.
The first four steps stop the run when they fail; the rest all run and the
exit code is non-zero if any of them failed.

| Step | Runs when | If it fails |
| --- | --- | --- |
| File selection | Always | `origin/master` must exist and share history with your branch: `git fetch origin master`, or `git fetch --unshallow origin` in a shallow clone. |
| Empty test check | Always | Every new test file needs at least one test. |
| Fleet registry | A `src/cli/fleet-*.ts` file changed | Run `node scripts/gen-fleet-registry.mjs` and commit the result. |
| Authority drift | The diff touches `src/`, `test/`, `scripts/` or `.github/CODEOWNERS` | Review the drift, run `npm run authority:regen` and list each new Tier-1 root in the pull request body. If `origin/master` moved since you branched, rebase first. |
| Docs check | A markdown file changed or a path was deleted | Fix the link or anchor it reports. |
| ESLint | A JavaScript or TypeScript file changed | Fix the reported lines. |
| Type check | Always (`tsgo`, falling back to `tsc`); the web project too when `src/web-ui/` changed | Fix the reported errors. With many parallel worktrees, `FAIL tsc slot wait` means no type-check slot freed in time (`PHANTOM_TSC_TIMEOUT_SECONDS`, default 900). |
| Real-I/O lane lint | Always | A changed test that spawns processes or does real I/O must be listed in `test/config/realio-lane-membership.mjs` (a protected path), or carry a comment near the match saying why it is safe in the fast lane. Files you did not change only print a `WARN`. |
| Verse sync-I/O lint | Always | No new synchronous filesystem or child-process call in a Verse route file (`src/core/verse/**/*-api.ts`) unless a `// sync-io-ok: <reason>` comment explains it. |

`SKIP eslint` or `SKIP docs check` with "run npm ci to restore it" means the
install is incomplete; run `npm ci` and then `node scripts/verify-changed.mjs --force`.

## 5. Push to your fork and open the pull request

```sh
git push fork <topic-branch>
gh pr create --repo ashlrai/phantom --base master --head <you>:<topic-branch>
```

Fill in the [pull request template](https://github.com/ashlrai/phantom/blob/master/.github/PULL_REQUEST_TEMPLATE.md):
what changed, the exact commands you ran, and anything you skipped. Fleet agents
push only to forks as well, through their own publish wrapper; nobody pushes
directly to `master`.

## 6. What CI requires

`Merge Gate` is the single required check. On a pull request it passes only
when these jobs succeed:

| Job | What it checks |
| --- | --- |
| Secret-shape scan | Added lines contain nothing token-shaped outside fake test fixtures. |
| Secret scan (diff) | A second secret scan over the diff. |
| Classify | Picks the lane (site, docs or full) for the change. |
| Check generated files | Regenerated docs indexes and launcher digests match what you committed. |
| Fast gate (typecheck + affected tests) | Type check plus the tests your diff selects; docs-only diffs run no tests. |

Quick typecheck also runs but is advisory. The full backend, Windows and macOS
suites do not run on pull requests; they run on the six-hour scheduled
`master` run, and failures there are fixed forward. Read the actual check run
for your commit; a workflow file is not evidence that it passed. GitHub may
ask a maintainer to approve workflow runs for a first-time contributor.

## 7. Auto-merge

The repository merges through GitHub's merge queue with auto-merge. Agents with
write access arm it with `gh pr merge --auto`; from a fork you cannot, so a
maintainer or fleet agent arms it for you. Once armed, the pull request merges
as soon as `Merge Gate` passes in the queue, with no separate manual merge
step. If `master` moves and your branch conflicts, rebase onto `origin/master`,
rerun the checks in step 4, and push again.

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
