# Contributing to Phantom

Phantom (`@ashlr/phantom`, source repository `ashlrai/phantom`, formerly `ashlr-hub`) is an open-source workbench for running coding agents, coordinating a fleet and reviewing their work. It is built contract-first in TypeScript with a React operations console. This guide covers source development and local verification, not provider commissioning or production publication. See the [documentation map](docs/README.md) for the current runtime and operator guides.

**Mission:** chasing open-source RSI (recursive self-improvement). Phantom and its separately installed companions (Phantom Secrets, Ashlr Plugin, Locus, Lexicon, Ashlr MD, Ashlr Stack) aim to form a fully autonomous, code-first, agent-native software factory. See [the mission](README.md#mission) and [the ecosystem](README.md#the-phantom-ecosystem).

**Who contributes:** mostly coding agents, including Phantom's own fleet, with the human owner as a passive board member needed only for passwords, 2FA, device approvals and payments. Agents follow [AGENTS.md](AGENTS.md), which sets what they may do (branch, open pull requests, merge and dispatch releases through the sanctioned workflow) and the kept limits. Humans and outside contributors are welcome and use the same checks below. Either way, keep one coherent change per pull request and verify it as described in [Definition of green](#definition-of-green).

**First contribution?** Coding agents build most of Phantom, and outside
contributors take the same path as the fleet: one focused branch pushed to a
fork, local checks run once, a pull request, and the one required check,
`Merge Gate`. [Contribute with an agent](docs/CONTRIBUTE-WITH-AN-AGENT.md)
walks that path from clone to auto-merge; agents also follow
[AGENTS.md](AGENTS.md). This guide holds the full conventions behind it.

---

## Contribute with an agent

The shortest path from a fresh clone to a mergeable pull request. It works the
same whether you or a coding agent (Claude Code, Codex, Cursor and others) does
the typing. [Contribute with an agent](docs/CONTRIBUTE-WITH-AN-AGENT.md) has the
full walkthrough and recovery steps.

1. **Clone upstream, push to your fork.** `scripts/verify-changed.mjs` diffs
   against `origin/master`, so keep `origin` pointing at this repository and
   add your fork as a second remote. Use a full-history clone so diff-based
   checks have a merge base:

   ```sh
   git clone https://github.com/ashlrai/phantom.git && cd phantom
   git remote add fork https://github.com/<you>/phantom.git
   git switch -c <topic-branch>
   ```

2. **Install.** Node 22.15+. Use `npm ci` for one checkout. For several trusted
   local worktrees, use `npm run install:worktree` instead; it requires pnpm
   10.28.2 (see [Shared installs](#shared-installs-for-trusted-local-worktrees)).

3. **Brief the agent.** Point it at [AGENTS.md](AGENTS.md) (the constitution and
   "Working in this repository"); Claude Code also loads [CLAUDE.md](CLAUDE.md).
   Keep one coherent change per pull request: logic in `src/core/`, thin
   handlers in `src/cli/`, `.js` import extensions, hermetic tests, and contract
   files updated with any exported signature ([conventions](#conventions)).
   Fleet agents open pull requests around the clock, so search open pull
   requests and issues for your area first, and open an issue before a larger
   feature ([Make one change](docs/CONTRIBUTE-WITH-AN-AGENT.md#3-make-one-change)).

4. **Verify locally**, once, in the foreground:

   ```sh
   node scripts/verify-changed.mjs                # changed-file lint, one typecheck, docs links
   npm run test:ci -- test/<affected>.test.ts     # affected backend suites, isolated HOME
   npm run test:web                               # when src/web-ui or desktop changed
   npm run check:docs                             # if verify-changed skipped it
   npx vitest run test/doc-facts.test.ts          # when docs name commands, flags or scripts
   ```

   `npm run gate` runs build, static checks and related tests together if you
   prefer one command. Never weaken a test to make a check pass.

5. **Commit and open the pull request.** Push the branch to `fork` and open
   the pull request against `master`
   (`gh pr create --repo ashlrai/phantom --base master --head <you>:<topic-branch>`).
   Pull requests land as squash commits, so the pull request title becomes the
   commit subject on `master`: give it a conventional prefix
   (`docs(readme): ...`, `fix(cli): ...`) so release-please files it under the
   right `CHANGELOG.md` section. The [pull request template](.github/PULL_REQUEST_TEMPLATE.md)
   asks for the commands you ran and includes the safety checklist for changes
   to the autonomous path.

6. **What hosted CI requires.** Pull requests and merge-queue commits run only
   the Ubuntu fast gate. `Merge Gate` is the one required check, and it passes
   when the two secret scans, lane classification, the generated-file check
   and the fast gate (typecheck plus affected tests) succeed. Quick typecheck
   and the authority-drift check also run but are advisory. macOS, Windows and exhaustive suites run on master's six-hour
   schedule after merge; a red full run opens a fix-forward issue for the
   failing commit. See [What CI requires](docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires)
   for details. GitHub may hold workflow runs on a first-time contributor's
   fork pull request until a maintainer approves them.

7. **How it merges.** Pull requests land through GitHub's merge queue with
   auto-merge, and the queue reruns the fast gate on the combined commit. You
   cannot arm auto-merge from a fork, so a maintainer or fleet agent arms it
   for you; once armed, the pull request merges as soon as `Merge Gate` passes
   in the queue. If it fails while `master`'s own run is red too, see
   [When a check fails for a reason outside your change](docs/CONTRIBUTE-WITH-AN-AGENT.md#when-a-check-fails-for-a-reason-outside-your-change). Paths listed in
   [CODEOWNERS](.github/CODEOWNERS) (CI configuration, authority and safety
   surfaces) also need the owner's review. If authority drift fails, run
   `npm run authority:regen` and list each new Tier-1 root in the pull
   request body.

Changes that weaken a [safety invariant](#safety-invariants-contributors-must-never-weaken)
are refused regardless of who opens them.

### What Merge Gate requires

Pull requests and merge-queue batches run the fast gate. These jobs must
succeed for `Merge Gate` to pass:

| Check | What it does |
|-------|--------------|
| Secret-shape scan, Secret scan (diff) | Fail closed on secret-shaped values in the diff |
| Classify PR site lane | Sorts the change into the site, docs or full lane |
| Check generated files | Checks canonical launcher digests and runs `node scripts/generate-docs-llms.mjs`; fails if the generated tree changes |
| Fast gate (typecheck + affected tests) | Type checks, then runs the tests selected from the diff, including doc-reading tests for docs-only changes |

Tests that require a built `dist/` stay in the full suites, which build first;
the fast gate has no build step. See [What CI requires](docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires)
for the advisory checks and full-suite schedule. A passing local check does
not replace these hosted results or the owner review for
[CODEOWNERS](.github/CODEOWNERS) paths.

### Updating a pull request

Keep the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) current with
the exact checks you ran and any checks you could not complete.

If you add or rename a document under `docs/`, run
`node scripts/generate-docs-llms.mjs` and include its output in the same pull
request. The generated-file check fails when that index is stale; the focused
generator avoids unrelated changes from `npm run docs:sync`.

If `master` moves and your branch conflicts, rebase onto `origin/master`,
rerun the local checks and update the pull request from your fork. Keep the
checks and any remaining limitations in the pull request description current.

---

## Prerequisites

- **Node.js 22.15+** for the package runtime. A release gate can require stricter, exact tool versions; use the [release policy](docs/RELEASING.md#qualified-ci-build-handoff) for release verification.
- **git** on `PATH`
- `~/.local/bin` on your `PATH` if you want to install the CLI locally
- Optional (only exercised at runtime by specific commands): `phantom`, `ollama`, LM Studio, `gh`, `vercel`, `claude`, `codex`. None are required to build or test.

The backend uses TypeScript/ESM, `tsx`, Vitest and ESLint. The web console uses
React, Vite, Testing Library and jsdom. [package.json](package.json) and the
lockfile are the canonical dependency inventory; do not maintain another version
list in a guide.

---

## Setup

```sh
git clone https://github.com/ashlrai/phantom.git
cd phantom
npm ci                    # single clone; also what CI and release packaging use
```

Keep the upstream repository as `origin`: `node scripts/verify-changed.mjs`
diffs against `origin/master`. Add your fork as a second remote to push to.
If you run several agents in trusted local worktrees on one machine, use
`npm run install:worktree` instead of `npm ci` in each worktree; it requires
pnpm 10.28.2 and shares one dependency store (see
[Shared installs for trusted local worktrees](#shared-installs-for-trusted-local-worktrees)).

Run focused verification locally while developing. Pull requests and default-branch
pushes run the repository's CI workflow. The Dependency Audit workflow runs on
them only when a manifest, lockfile or other dependency input changes, plus a
daily schedule. Check the actual run for your commit; workflow source alone is
not evidence that it passed.
Dependency changes must keep the
affected manifest and lockfile consistent, including separately packaged Raycast
or desktop dependencies when those are in scope.

The package bundles its declared runtime dependencies for offline installation.
See [Dependency boundary](#dependency-boundary) below.

To install the CLI while developing:

```sh
./install.sh    # builds dist/, links bin/ashlr → ~/.local/bin/phm and ~/.local/bin/ashlr, smoke-tests `help` on both
```

`install.sh` is idempotent — re-run it after pulling changes. It creates only absent links and refuses to replace an unrelated file or link.

---

## Everyday commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Run the CLI from source via `tsx` (no compile step). E.g. `npm run dev -- status` |
| `npm test` | Run the backend unit, real-I/O and serial-CPU projects once (`vitest run`); web tests are separate |
| `npm run test:serial` | Run tests without file parallelism — required for tests that touch the same home dir |
| `npm run test:ci` | Run backend lanes locally with isolated test homes, inactivity detection and a hard runtime cap |
| `npm run test:ci:balanced` | Run the complete backend suite as four concurrent shards balanced by measured file durations |
| `npm run test:web` | Run the separate jsdom/Testing Library console and desktop-component suite |
| `npm run test:engineering-responsiveness` | Run the explicit macOS real-CLI two-second control-room latency gate; not implied by default test success |
| `npm run eval:routing` | Score the offline routing corpus: local share, escalation reasons, accuracy, and a labeled frontier dollar estimate. Not part of CI. |
| `npm run dev:web` | Run the Vite development server; it does not commission providers or enable dispatch |
| `npm run lint` | ESLint plus real-I/O membership and Phantom console synchronous-I/O guards |
| `node scripts/verify-changed.mjs` | Lint only the files changed against origin/master, run the type checks the diff selects (the backend/web projects, plus the `contrib/router` program when a router `.ts` file, `src/core/authority/protected-paths.ts` or a shared manifest changes), run the documentation link check when the diff touches markdown or deletes files, run the quarantine-ledger check when test files or `queue/quarantine.tsv` change, and syntax-check changed `.py` files with `python3`, changed `.sh` files with `bash -n`, changed `.pl` files with `perl -c`, changed `.json`/`.webmanifest`/`.tsbuildinfo` files with `JSON.parse`, and changed `.xml`/`.plist`/`.plist.in`/`.svg` files with `python3`'s ElementTree parser, changed `.rs` files with `rustfmt`, changed `.swift` files with `swiftc -parse`, changed `.yaml`/`.yml` files with the bundled `yaml` package, changed `.toml` files and `Cargo.lock` manifests with `smol-toml`, and changed `.css` files with the `lightningcss` parser Vite bundles, and changed `.snap` files with node's script parser, and changed `.patch`/`.diff` files with `git apply --stat`, changed `.html`/`.htm` files' embedded script, JSON and style payloads with the bundled `jsdom` package, node's `vm` parser and the `lightningcss` parser, changed `.sb` Seatbelt profiles with an in-process s-expression parse, changed `.mdc` agent-rule files' `---`-fenced YAML frontmatter with the bundled `yaml` package, scripts under `src/raycast/` and `examples/universe-site/` with the bundled `typescript` parser, and every changed text file for leftover git merge-conflict markers; the fast local gate before pushing. Repeats on an unchanged tree are skipped (`--force` reruns). Local checks do not replace `Merge Gate`, the one required hosted check ([What CI requires](docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires)). |
| `npm run check:docs` | Validate operator documentation file links and anchors locally, without network requests |
| `npm run check:perf` | Time the committed CLI cold-path budgets in `perf/budgets.json` (hyperfine when installed); advisory in CI, never a required check |
| `npm run docs:sync` | Regenerate every generated docs surface (freshness blocks, site pages, CODEMAP inventory, llms indexes); `-- --check` reports drift without writing |
| `node scripts/check-test-names.mjs` | Flag duplicate test names across `test/` that collide in name-keyed reports |
| `node scripts/generate-cli-docs.mjs` | Regenerate `docs/cli.md` from `phm --help` output; `--check` compares without writing |
| `npm run typecheck` | Strict backend, web and desktop type checks, without emitting files |
| `npm run typecheck:fast` | The same projects through `tsgo`, the native compiler; what `npm run gate` phase A runs |
| `npm run gate` | Fast local gate: build, static checks, the tests related to your diff and the smoke set, against the merge-base with `origin/master`; `-- --base <ref>` picks another base and `-- --json` prints a machine-readable result. Local feedback only; it never pushes or contacts model providers |
| `npm run gate:full` | The same static checks, then the complete backend and web suites |
| `npm run check:quarantine` | Validate `queue/quarantine.tsv`; with `-- --base origin/master`, also require a live ledger row for every skip marker your diff adds and refuse an added `.only` |
| `npm run authority:regen` | After authority drift, regenerate `.github/CODEOWNERS` and the Tier-1 closure snapshot (`test/fixtures/authority/tier1-closure.json`) and print what changed; list each new Tier-1 root in the pull request body |
| `npm run install:worktree` | Shared pnpm install for trusted local worktrees (see [Shared installs](#shared-installs-for-trusted-local-worktrees)) |
| `npm run build` | Check candidate version sync, compile the backend, generate the authority surface, copy assets, build the built-in preparation evaluator and the web console, then generate dependency inventory and Git build identity in `dist/` |
| `npm run build:web` | Build only the React web console bundle into `dist/core/web/public/next/`, so `npm run dev -- verse` (and `serve`) can serve `/verse/`, `/app/` and `/next/` without a full `npm run build` |

For explicit Bun-compatible test inventories, see the standalone
[Bun shard planner and timings recorder](docs/BUN-SHARDS.md). Workflow adoption
is separate from these scripts.

Use `node scripts/verify-changed.mjs` after editing a few files, before opening a pull request, or when the full lint takes too long. It operates only on the diff against `origin/master` and does not run the affected test suites; run those separately. It can run authority drift tests when master has moved. It does not replace `Merge Gate`, the one required hosted check: on a pull request that check runs the secret scans, the generated-files check and the fast gate, not ESLint or `check:docs`; run those locally before pushing. Full suites run on the scheduled `master` run. When the diff changes a markdown file or deletes any path, it also runs the same documentation link and anchor check as `npm run check:docs`; run `npm run check:docs` yourself when you want the report without the rest of the gate. When the diff touches a test file or `queue/quarantine.tsv`, it runs the same quarantine-ledger verifier as `npm run check:quarantine`, so an added `.skip`/`.todo`/`.only` without a live ledger row fails locally instead of at the gate. When the diff touches `.py` files — the fleet's Python dispatcher and bridge tooling had no other local check — it compiles them with the system `python3` and skips with a notice when no interpreter is available. Changed `.sh` files get the same treatment through `bash -n`, the acceptance command queuegen already assigns to shell jobs, skipping with a notice when `bash` is unavailable. Changed `.pl` files — the secret-shape gate `scrub.pl` and its fixtures are Perl — are compile-checked with `perl -c`, which parses and compiles without running the script body, skipping with a notice when `perl` is unavailable. Changed `.json`, `.webmanifest` and `.tsbuildinfo` files are strict-parsed with `JSON.parse` — the grammar `tsconfig.json`, the fleet manifests, TypeScript's incremental build-info records and the Web App Manifest spec already require — with no interpreter preflight, so the step never prints `SKIP` when a `.json`, `.webmanifest` or `.tsbuildinfo` file changed. Changed `.xml`, `.plist`, `.plist.in` and `.svg` files are well-formedness-parsed with `python3`'s `xml.etree.ElementTree` — the grammar `plutil`, sitemaps and SVG renderers enforce — skipping the binary and ASCII plist encodings (the `.plist.in` launchd templates are always XML text and parse unconditionally) and printing `SKIP` when no `python3` is available. Changed `.rs` files are parsed by `rustfmt --emit stdout` (no formatting enforced, nothing written) and changed `.swift` files by `swiftc -parse` (the parser stage only — no type check or module resolution); each skips with a notice when its toolchain is unavailable, matching the Python and shell checks. Changed `.yaml`/`.yml` files are parsed by the bundled `yaml` package — every document of a multi-document file is checked and duplicate keys are errors, the same rejections GitHub's workflow parser and pnpm apply — and changed `.toml` files and `Cargo.lock` manifests — TOML at any depth, e.g. `desktop/src-tauri/Cargo.lock` — by `smol-toml`; each prints `SKIP` when its package is not installed under `node_modules`. Changed `.css` files are parsed by `lightningcss` — the CSS parser Vite bundles for the web-ui build — resolved through vite's installed dependency closure so pnpm's transitive layout works without a new dependency; it prints `SKIP` when vite or the parser cannot be resolved. Changed scripts under `src/raycast/` and `examples/universe-site/` — authored trees `eslint.config.js` ignores and no root `tsconfig` covers, each owning its toolchain — are parsed by the bundled `typescript` package's `createSourceFile` diagnostics, the parse `tsc` itself applies; the step prints `SKIP` when the package is not installed under `node_modules`. Changed `contrib/router` program inputs — a `.ts` file under `contrib/router/`, its only source-tree import `src/core/authority/protected-paths.ts`, or `package.json`/`package-lock.json` — additionally run the `tsc --noEmit` file-list type check `contrib/router/SUPERVISOR.md` documents inside a typecheck slot: the router executes under `tsx`, which transpiles without checking types, and no `tsconfig` project covers the tree; the step prints `SKIP` when the `typescript` package is not installed under `node_modules`. Changed `.snap` files — vitest snapshot modules that eslint and tsc never read — are compiled in-process with node's script parser, so the step has no preflight and never prints `SKIP`. Changed `.patch` and `.diff` files are parsed by `git apply --stat` — the unified-diff grammar every `git apply` consumer enforces, checked without requiring the patch to apply in this checkout so staged proposals against other revisions still verify — with no preflight, so the step never prints `SKIP`. Changed `.html`/`.htm` files — the public site, the web console shell, the Tauri launch window and benchmark pages embed `<script>`, JSON (`ld+json`, `importmap`) and `<style>` payloads that ESLint, the type check and the site's own DOM tests never parse — have each payload checked in a child process: script bodies with node's `vm` parser under the classic or module goal the `type` attribute selects, JSON script types with `JSON.parse`, and style rules with the same `lightningcss` parser as `.css` files; the bundled `jsdom` package enumerates the payloads, external `src` scripts, inert `type` values, empty bodies and `<noscript>` scripts are skipped, `<template>` content is checked, `test/fixtures/` markup is exempt, the step prints `SKIP` when `jsdom` is not installed, and `<style>` payloads warn-skip when `lightningcss` cannot be resolved through vite. Changed `.sb` files — macOS Seatbelt sandbox profiles, the GATES-v3 confinement boundary under `contrib/mac/` — are structurally parsed in-process as s-expressions: balanced parentheses, terminated string and `#"..."` regex literals, and every top-level form a list headed by an atom; operation names stay unchecked so new SBPL forms are never rejected, and the step has no preflight or `SKIP`. Changed `.mdc` files — agent rule files — have their `---`-fenced YAML frontmatter parsed with the bundled `yaml` package; a leading fence promises frontmatter, an unterminated fence or a rejected block fails, files without one are plain markdown, and the step prints `SKIP` when `yaml` is not installed. Every changed text file is also scanned for leftover git merge-conflict markers — the column-0 `<<<<<<<`, `|||||||` and `>>>>>>>` lines a botched resolution leaves behind, which the per-type grammars cannot see inside strings, comments and template literals and which parser-less file types (markdown, TSV, HTML, extensionless data) never reject; binary files and `test/fixtures/` payloads — inputs that may legitimately embed marker text — are exempt, and the step has no preflight or `SKIP`. A working state that already passed exits early via a marker shared across worktrees; `--force` (or `PHANTOM_VERIFY_FORCE=1`) reruns it.

`bin/ashlr` is a thin ESM shim that imports `dist/cli/index.js`, so the installed binary always runs the compiled output. For fast iteration, use `npm run dev` (runs `src/cli/index.ts` directly through `tsx`).

### Focused iteration

Run the affected existing files while editing. These commands use the same
hermetic backend runner and web configuration as the complete suites:

```sh
npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/gate.test.ts test/m481.ci-action-pins.test.ts test/m522.production-promotion-docs.test.ts
npm run test:web -- src/web-ui/routes/verse/usage/CapacityStrip.test.tsx src/web-ui/routes/verse/resources/ResourcesBar.test.tsx --maxWorkers=1 --no-file-parallelism
npm run check:docs
```

Choose the files relevant to your change; the examples are independent backend
and web selections. If a selected test reads compiled output or copied assets,
run `npm run build` first. Include `npm run typecheck` and `npm run lint` in a
source-only check; the complete release command below already runs them.
`npm run gate` also provides related-test and smoke feedback,
but its import graph cannot discover dependencies read as text: select those
files explicitly. Neither focused commands nor the gate replace release checks.

For an offline smoke preview of a committed change, set `BASE_SHA` to a local
ancestor commit and `HEAD_SHA` to the clean checkout’s current commit, using full
40-character SHAs. Replace the example path with **every** changed path between
those commits, including deletions:

```sh
node scripts/test-smoke-preview.mjs --root . --base "$BASE_SHA" --head "$HEAD_SHA" --changed src/core/run/model-catalog.ts
```

The JSON reports whole-module import suggestions and unknown/global-input
warnings. It runs no tests and cannot authorize release skips or result reuse;
an empty suggestion list does not establish coverage.

Contributors do not need test-ordering or partition tuning. Maintainers can
find the opt-in failure-first ordering and duration-weighted Mac partition
hints in [CI test feedback](docs/CI-TEST-FEEDBACK.md#duration-weighted-partition-hints);
both are off by default.

### Definition of green

#### Keep development and release checks economical

Run the affected whole test modules while editing, then `npm run gate -- --base
<base-sha>` for related tests and static checks. Use an explicit base when
integrating parallel branches so the selection includes every combined change.
The local gate does not push, dispatch Actions, or contact model providers.
Its import graph cannot cover tests that read source as text; also run
`npm run check:release:fast` after the canonical build for release changes.

For final local source qualification, run `prepublishOnly` once as described
below. Reuse the exact completed hosted build for canonical publication instead
of rebuilding or repacking it. Local feedback does not replace protected merge
checks, independent Audit, attestation, signing, or installed acceptance.

Standard GitHub-hosted runners are free in public repositories; larger runners
and private-repository usage have different billing rules. Artifact and cache
storage have separate allowances. Before starting hosted work, verify repository
visibility, runner labels, current usage, and the owner's blocking budget through
GitHub's billing readback. Do not increase a budget or select a paid runner as a
fallback. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

#### Complete source qualification

For the complete local source release check, run the canonical script once:

```sh
npm run prepublishOnly
```

It builds first, then checks first paint, docs, types and lint, runs the complete
web suite, and finally runs the exhaustive backend partitions and isolated
cases. Running `gate:full` or repeating these full suites immediately beforehand
adds duplicate work rather than release coverage.

Preserve meaningful coverage. Backend tests live under `test/`; DOM tests live
beside the web features under `src/web-ui/`. Report skipped or unavailable
platform checks separately. A passing source suite is not installed-artifact,
provider, production or user-acceptance evidence. Release work also follows the
[qualified release handoff](docs/RELEASING.md#qualified-ci-build-handoff).

### Running tests hermetically on the local host

```sh
npm run test:ci
```

Despite its name, `test:ci` is a local command. It isolates HOME/ASHLR_HOME and
exits with code 124 if Vitest produces no output for
`ASHLR_TEST_CI_IDLE_TIMEOUT_MS` (default 5 minutes) or exceeds
`ASHLR_TEST_CI_TIMEOUT_MS` (default 30 minutes). The diagnostics distinguish an
inactive process from an actively progressing suite that reaches the hard cap;
only inactivity after Vitest's final summary is evidence of a possible leaked
handle. The runner preserves the separate worker limits of the unit and
serialized real-I/O lanes defined in [vitest.config.ts](vitest.config.ts).

The complete synthetic memory performance file runs in the `serial-cpu` Vitest project after the unit and real-I/O groups. It keeps one worker and the same five-second case bound; all 1,024 events, alternating raw/prepared observations and receipts remain. Raw Ubuntu shards and Mac collection include this project automatically. `lint:realio-lane` accounts for the separate manifest and refuses overlapping or missing members.

The Ubuntu authority 1/3 producer has a 60-minute outer job limit: it runs the
complete web suite before the existing 30-minute backend wrapper, then verifies
and uploads the original package. Measured setup/build took three minutes and
web took eleven minutes; a 25-minute combined job cancelled healthy backend work.
Other matrix roles retain their 25-minute limits. Test and worker bounds are unchanged.

Hosted Mac general jobs use a 90-minute outer limit, matching their existing
90-minute hermetic wrapper. Complete measured single-worker partitions took
60–65 minutes; a 45-minute outer job could not finish them. Per-test deadlines,
worker memory limits, idle detection and required qualification roles are unchanged.
Hosted Darwin runs print numeric capacity observations after the worker policy:
raw free/available memory, VM free/inactive/speculative/purgeable pages and kernel
pressure stay separate; diagnostic values never change admission or worker count.

Hosted CI includes exhaustive Ubuntu shards, named Windows portability contracts,
four exhaustive Mac partitions, a separate Mac lane for all isolated suites
(two at a time, each in its own home with one worker; locally they stay serial
unless `ASHLR_TEST_CI_ISOLATED_CONCURRENCY=2`), macOS queue coverage, native
broker checks and the Windows service authority lane. None of these lanes runs
on a pull request, in the merge queue or on a `master` push; there `Merge Gate`
runs the secret scans, the generated-files check and the fast gate. The full
Ubuntu, Windows and Mac lanes run on the six-hour scheduled `master` run and
on manual dispatch. The scheduled run rotates the exhaustive Mac work over
seven daily slices; a dispatch defaults to the complete set. The reusable
release call retains the Ubuntu/Windows matrix but defers the macOS and
Windows service lanes to the scheduled run. Failures there are fixed forward.
Local tests and hosted checks prove different environments. Inspect each actual run and report unavailable or
skipped coverage separately; do not weaken checks to make a release pass.

The optional [qualified build handoff](docs/RELEASING.md#qualified-ci-build-handoff)
reuses the same tested build and package bytes after complete CI qualification
and trusted attestation. It preserves native packaging, signing, installation
and live verification. `npm run prepublishOnly` remains the full local fallback.

---

## Conventions

### ESM / NodeNext — `.js` import extensions

The project is `"type": "module"` with `module`/`moduleResolution` set to `NodeNext`. **Always import sibling modules with the `.js` extension**, even though the source file is `.ts`:

```ts
import { getGitStatus } from './git.js';        // not './git' or './git.ts'
import type { AshlrConfig } from './types.js';
```

NodeNext resolution requires this at runtime for the backend. The separately
configured `src/web-ui/` tree uses Vite's bundler resolution; follow its existing
imports and never introduce Node-only runtime imports into browser modules.

### Strict TypeScript

`tsconfig.json` enables `strict`, plus `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch`. Write code that passes `npm run typecheck` with zero suppressions. Avoid `any`; use the canonical types owned by the relevant subsystem.

### Dependency boundary

`src/core/` and `src/cli/` primarily use Node builtins. The declared runtime
dependencies are `@modelcontextprotocol/sdk` for MCP, `marked` for external-skill
Markdown analysis, `tar` for managed-runtime archives, `smol-toml` and `yaml` for
TOML/YAML parsing, `zod` for runtime schema validation, and `@simplewebauthn/server`, `@simplewebauthn/browser`,
`jose`, `reflect-metadata` and `web-push` for the optional phone gateway. They
are listed in `bundleDependencies`, bundled in the package and verified by the release dependency inventory. **Do not add a
runtime dependency casually:** reuse an existing utility first, and change the
dependency contract, lockfile, inventory and verification together if a new
dependency is justified. React/Vite build dependencies do not make Node-only
core modules safe to import into the browser.

### One module per file

Each subsystem is a single focused module that owns one responsibility. CLI command handlers live in `src/cli/` and stay thin — they parse argv and delegate to `core/`. `src/core/` subsystems do not reach into CLI modules.

### Hermetic vitest tests

Tests must be hermetic. Drive code through injected config and temp directories; fixtures live in `test/fixtures/`. A test must pass identically on any machine and in CI. Never read from or assert against the user's actual home directory or model endpoints. Use `test/helpers/` for fixture building.

### No personal absolute paths in source

Resolve runtime paths from `os.homedir()`. Use homedir-relative placeholders (`~/Desktop`, `/Users/you/...`) in docs and comments. The config layer already does this; don't bypass it.

### Author attribution

Author attribution (Mason Wyatt / `masonwyatt23` / ashlr.ai) is intentional and must be preserved in source headers and package metadata.

---

## Contracts-first pattern

Phantom is built **contract-first**: interfaces and types are authored before code, so multiple agents can build disjoint modules in parallel without colliding.

1. **Use the owning subsystem's canonical types.** `src/core/types.ts` is the public entry point for shared Hub types: a barrel of `export type *` lines over the domain modules in `src/core/types/` (`config.ts`, `engines.ts`, …), where each declaration lives. Edit the domain module, not the barrel. Universe, Resources and local-runtime also own focused type modules; import their existing contracts instead of duplicating them or growing a global catch-all. Browser consumers should use type-only imports for server DTOs.

2. **`CONTRACT.md` plus per-milestone files** (`docs/contracts/CONTRACT-M<N>.md`) are the binding interface spec. Each pins the exported function signatures and type shapes a milestone's modules must satisfy. Do not change an exported signature without updating the corresponding contract file in the same change.

3. **Build to the contract.** Implement against the declared signatures so that modules written independently compose cleanly.

When changing a public surface, identify its owning type module and any binding
contract, update those together, then implement and test. Routine changes do not
require a new milestone document when an existing canonical contract is enough.

---

## Safety invariants contributors must never weaken

The following invariants are enforced by named adversarial tests. A PR that weakens any of them will not be accepted — and the fleet's own self-improvement harness (M54) is also blocked from doing so:

1. **Proposal-only floor.** The daemon source may import no merge/apply primitive. Auto-merge is a separate gated module, default off. Test: `test/h1.daemon-gates.test.ts` and `test/h4.proposal-only.test.ts` (source-scan grep-guards) + `test/m48.automerge-pass.test.ts`.
2. **Enrollment gate.** Only enrolled repos receive autonomous work. Tests: `test/h4.sandbox-enrollment-kill.test.ts` (invariant 3) and `test/h1.daemon-gates.test.ts` (empty enrollment makes a tick a no-op); `test/h6.audit-completeness.test.ts` checks that every enrollment change is audited; `test/h6.audit-policy.test.ts` covers enroll, unenroll and kill changes at the policy primitive and CLI without double-counting.
3. **Kill-switch always halts.** `~/.ashlr/KILL` present must stop every backend and every repo. Tests: `test/h4.sandbox-enrollment-kill.test.ts` (invariant 4: the kill check runs before the enrollment check and `allowAnyRepo` cannot override it), plus `test/h1.daemon-gates.test.ts` and `test/m48.fleet-supervisor.test.ts` (a tick halts with reason `kill-switch` before any dispatch).
4. **Sandboxed-with-diff-capture only.** In the autonomous loop, external engines run only through `runEngineSandboxed`. No raw-external path. Sandbox-creation failure is terminal, never a silent fallback. Tests: `test/h4.sandbox-enrollment-kill.test.ts` (invariant 2: a sandbox that cannot be created aborts to zero tasks) and `test/m45.foundry.test.ts` (a failing engine run is contained and leaves no sandbox behind).
5. **Git push blocked from sandbox.** The pre-push hook + credential strip must fail every push from a worktree. Test: `test/m45.foundry.test.ts` (the pre-push containment proof, plus the `buildContainedEnv` credential checks).
6. **Only the diff is consumed.** No transcript, no live-tree write escapes the sandbox. Tests: `test/h1.daemon-gates.test.ts` (a tick leaves the enrolled repo's working tree byte-identical), `test/h1.chain.test.ts` and `test/h1.apply-guardrails.test.ts` (a captured diff lands only on a new proposal branch; a refused apply mutates nothing). `test/m21.worktree.test.ts` checks source-tree isolation through create, edit, diff and remove; `test/h4.sandbox-containment.test.ts` covers diff consumption containment.
7. **Immutable signed provenance.** `{engineModel, engineTier}` is write-once and HMAC-signed. The merge gate must verify the HMAC. Test: `test/m47.*`, `test/m47_1.*`.
8. **Merge requires explicit policy and verification.** Default tier mode requires frontier provenance and a matching `mergeAuthority` entry. Opt-in verification/evidence modes have their own stricter gates; no producer verdict, test result or documentation change grants authority by itself. See the [safety model](docs/HUB-REFERENCE.md#safety-model) and `test/m47.*`, `test/m153.*`, `test/m307.*`.
9. **Self-improvement cannot self-disarm.** Self-target diffs must pass the suite flag-off and flag-on. Safety-test-weakening diffs refused. Test: `test/m54.*`.
10. **Preserve the declared dependency boundary.** Manifest, lockfile and packaged dependency inventory must agree; do not bypass the associated tests.

If you are adding a new safety invariant, the pattern is: add the invariant to `docs/SPEC-V*.md`, write the named adversarial test first, then implement.

---

## Adding a new backend engine

Backends are registered in `src/core/run/engine-registry.ts`. To add a new one:

1. Add an entry to `BUILTIN_ENGINE_REGISTRY` with `id`, `kind`, `tier` (`local | mid | frontier`) and either `bin`/`argv` (a `cli-agent`) or `api` (an `api-model`); see `EngineSpec` in `src/core/types/engines.ts`.
2. If it is API-based (OpenAI-compatible), confirm it works through the existing `provider-client.ts` path.
3. Add a `cfg.foundry.engines` example to `docs/examples/foundry.config.json`.
4. Add a test that asserts the new entry resolves to byte-identical argv and that its tier is correct.

No changes to `buildEngineCommand`, `engineInstalled`, or `engineTierOf` should be necessary — they read the registry.

## Adding a new scanner

Portfolio scanners live in `src/core/portfolio/scanners.ts`. Each scanner is an async function that returns `WorkItem[]`. Add your scanner, register it in `SCANNER_REGISTRATIONS`, and add a test with a mock repo fixture.

## Adding a new comms transport

Comms transports live in `src/core/integrations/` (`telegram.ts`, `imessage.ts`). There is no shared transport interface: add the transport module, extend the `comms.channel` union in `src/core/types/config.ts`, branch on it in `runCommsCycle` in `src/core/comms/dispatch.ts`, and add a hermetic test with a mock transport.

---

## Commit style

- Keep commits focused and atomic; one logical change per commit.
- Use a concise, imperative subject with a conventional type prefix (e.g. `feat: add genome embedding rerank fallback`), with a body explaining the "why" when it is not obvious.
- Follow [Conventional Commits](https://www.conventionalcommits.org/) syntax: `type(scope): imperative summary`, for example `docs(contributing): describe the first pull request path`.
- Pull requests land as squash commits, so the pull request title becomes the subject on `master`. release-please groups `master` subjects into `CHANGELOG.md` sections by type (see `release-please-config.json`): `feat` (Features), `fix` (Fixes), `bridge` (Changes), `perf` (Performance), `refactor` and `chore` (Maintenance), `docs` (Documentation), `test` (Tests), `ci` (CI) and `build` (Build). Fleet agents use the `bridge(<job>):` type; outside contributors pick the type that fits the change. A subject without a recognized type is left out of the changelog.
- A commit must preserve the [local verification gates](#definition-of-green), including web and documentation checks when those surfaces change.
- Do not commit `dist/` (it is git-ignored) or machine-specific paths.
- Milestone commits follow the pattern: `feat: M<N> <short description>` and update the milestone row in the relevant `docs/SPEC-V*.md`.

---

## Project layout

```
src/
├── api/           # Public SDK entrypoints (`@ashlr/phantom`, `/core`, `/types`, `/plugin`)
├── cli/           # Thin argv dispatchers — parse, delegate to core, format output
├── core/
│   ├── types.ts   # Barrel re-exporting the shared Hub types
│   ├── types/     # Shared Hub types by domain (config, engines, …); subsystems also own focused contracts
│   ├── universe/  # Experiments, evaluation, campaigns, archive, graph, delivery
│   ├── resources/ # Worker bindings, quota admission, ledger, foreground queue
│   ├── local-runtime/ # Pinned package install, verification and rollback
│   ├── run/       # Agent orchestrator, sandboxed engine, router, best-of-N
│   ├── swarm/     # Multi-agent swarm runner, signing, gates, rollback
│   ├── fleet/     # Manager judge, router, quota, feedback, learned routing
│   ├── goals/     # Goal store, milestone planner, conductor, advance
│   ├── vision/    # Leader, objectives, end-state spec and playbooks
│   ├── inbox/     # Proposal lifecycle: merge, apply, store
│   ├── sandbox/   # OS-level confinement: worktree, confine, audit, policy
│   ├── genome/    # Shared memory: store, recall, consolidate, playbook
│   ├── integrations/  # Telegram, iMessage, GitHub, Vercel, editors, Phantom
│   ├── comms/     # Bidirectional comms dispatch and handlers
│   ├── daemon/    # Continuous autonomous operator loop
│   ├── portfolio/ # Backlog scanners, value filter, EDV verify
│   ├── observability/ # Telemetry, spend rollup, budget alerts, OTLP
│   ├── learn/     # Reflect, playbooks, tuning
│   ├── verse/     # Console backend: chats, seats, accounts, agents, MCP tools
│   ├── web/       # Loopback HTTP server, API and optional phone gateway
│   └── ...        # config, git, classify, index-engine, providers, doctor, mcp, …
├── web-ui/        # React console, feature-local DOM tests, Vite entrypoints
├── raycast/       # Separate package (React/Raycast extension)
├── tui/           # Terminal UI renderer
├── mcp/           # MCP servers (context, docs) and fleet MCP tools
├── fleet/         # Bridge session record/replay and merge-confidence risk scoring
├── shared/        # Schemas shared by backend and console (e.g. team directory)
└── doctor/, planning/ # Tool version probes; task triviality classifier
test/              # Vitest suites organized by milestone
docs/
├── README.md      # Canonical documentation map
├── contracts/     # CONTRACT-M<N>.md — binding interface specs per milestone
├── SPEC-V4-FOUNDRY.md
├── SPEC-V5-OPEN-FLEET.md
├── SPEC-V6-VERIFICATION.md
└── ARCHITECTURE.md
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module map and the autonomous loop.

### Shared installs for trusted local worktrees

Use `npm run install:worktree` in place of `npm ci` when preparing local agent
worktrees. Install pnpm **10.28.2** first (`npm install -g pnpm@10.28.2`). The
helper installs the frozen `pnpm-lock.yaml` with lifecycle scripts disabled and
places the shared store in `<git-common-dir>/phantom-pnpm-store`. It checks that
store and worktree are on the same device (the Data APFS volume on our Macs).
Each worktree keeps its own `node_modules` links; dependency graphs are shared.
All store writers must be trusted. Never edit package files through these links.

The workspace's `enableGlobalVirtualStore: true` is pnpm 10's spelling of the
newer `virtualStoreType: global`; do not upgrade pnpm without updating the helper
and validating the layout. CI and releases continue to use `npm ci`; the helper
refuses CI because pnpm 10 disables its global virtual store there. Existing
npm installations should be removed before switching (`rm -rf node_modules` in
the intended checkout only). Test and development commands still use `npm run`.
The full `npm run build` includes the release inventory, which requires a real
npm dependency tree and intentionally rejects shared dependency symlinks. Use
an npm-installed release checkout for that command; local source execution,
`npm run typecheck`, tests, and `vite build --config vite.config.web.ts` work
with the shared installation. Do not relax the release inventory's path checks.

When changing dependencies, update `package-lock.json` with npm, mirror security
`overrides` in `pnpm-workspace.yaml`, then run `pnpm import` and include the
updated `pnpm-lock.yaml`. Run `npm run install:worktree` to verify the frozen
install. The store persists after worktree removal. Remove it only after all
linked worktrees are retired; deleting it breaks their dependency links.

To repeat the install comparison, run
`node scripts/benchmark-worktree-install.mjs . worktree-install-benchmark.json`.
It creates disposable manifest snapshots on the checkout volume, measures cold
and warm npm/pnpm installs with scripts disabled equally, verifies that pnpm
snapshots resolve Vitest to the same shared package directory, and removes its
temporary trees. The JSON separates per-checkout `du -sk` allocation from shared
store allocation. It is a single-trial local measurement, not a physical APFS
extent accounting or a general performance guarantee.
