# Changed-files verification (`scripts/verify-changed.mjs`)

Run the local pre-merge check from the repository root:

```
node scripts/verify-changed.mjs
```

Pass `--force` (or set `PHANTOM_VERIFY_FORCE`) to rerun a state that already passed.

## What it does

The steps run in this order and each prints one `PASS`, `SKIP`, `WARN` or
`FAIL` line. Steps 1–4 stop the run when they fail; every later step runs and
the exit code is non-zero if any of them failed.

0. **Skips already-passed states**: before any check it fingerprints the working tree (see "Pass dedupe" below) and exits 0 with `SKIP verify-changed` when that exact state previously passed.
1. **Collects changed paths**: files committed since the `origin/master` merge-base, plus staged, unstaged and untracked (non-ignored) files. Renames count as a deletion and an addition. When no merge base exists yet the script first tries to fetch one: it pulls the `origin/master` tracking ref (single-branch clones lack it), and in a shallow clone deepens master plus the remote branches on HEAD's truncated ancestry in growing stages until the fork point is reachable — the same recovery `git fetch origin master` or `git fetch --unshallow origin` performs by hand, bounded to a few fetches. Only when that still finds no merge base (unrelated histories, an unreachable remote, or a fork point deeper than the last stage) does it print `WARN no merge base: using working-tree status and diff against HEAD` and check only uncommitted changes, so committed work on the branch goes unchecked; `git fetch --unshallow origin` then `node scripts/verify-changed.mjs --force` is the manual fallback. It then prints one `verify: <n> changed files (<mode>), <scope>` line naming the type-check selections the diff picks (steps 10–11).
2. **Refuses empty new tests**: a changed test file with no test in it fails the run.
3. **Checks the fleet registry** with `node scripts/gen-fleet-registry.mjs --check` when a `src/cli/fleet-*.ts` file changed. Fix it by running `node scripts/gen-fleet-registry.mjs` and committing the result.
4. **Checks authority drift** with the CODEOWNERS and Tier-1 closure suites when a changed path is under `src/`, `test/` or `scripts/`, or is `.github/CODEOWNERS`. If `origin/master` has moved since the branch forked, the suites run again on a temporary overlay of your changes on current master, so a combination that drifts fails here rather than after merge. Without a merge base that overlay run is skipped with a `WARN`; the local suites still run.
5. **Runs the documentation check** (`scripts/check-documentation.mjs`, the same check as `npm run check:docs`) when a `.md` file changed or any path was deleted.
6. **Runs ESLint** on changed `.js`, `.mjs`, `.cjs`, `.ts`, `.cts`, `.mts`, `.tsx` and `.jsx` files still on disk, with ESLint's own config and ignores.
7. **Syntax-checks other changed files**: `.py` with `python3`, `.sh` with `bash -n`, `.pl` with `perl -c` (compile only, the same grammar step CI's secret-shape job applies to `scrub.pl`), `.ps1`/`.psm1`/`.psd1` with PowerShell's `Language.Parser.ParseFile` (parse only, never executes the script — `scripts/install.ps1`, the shipped Windows per-user installer, is the repo's member today), `.json`/`.webmanifest`/`.tsbuildinfo` with `JSON.parse` (the build-info suffix is TypeScript's incremental JSON record, e.g. `src/web-ui/tsconfig.minimal.tsbuildinfo`), `.jsonl` line by line with `JSON.parse` (each non-blank line must be one complete JSON value; blank lines carry no record), `.xml`/`.plist`/`.plist.in`/`.svg` with `python3`'s ElementTree parser, `.rs` with `rustfmt`, `.swift` with `swiftc -parse`, `.yaml`/`.yml`/`.cff` with the bundled `yaml` package, `.toml` and `Cargo.lock` (TOML at any depth, e.g. `desktop/src-tauri/Cargo.lock`) with `smol-toml`, `.css` with the `lightningcss` parser Vite bundles, scripts under `src/raycast/` and `examples/universe-site/` with the bundled `typescript` package's `createSourceFile` diagnostics (authored trees eslint and the root type check skip because each owns its toolchain), `.snap` with node's script parser, and `.patch`/`.diff` with `git apply --stat` (the unified-diff grammar, without requiring the patch to apply in this checkout). Changed `.html`/`.htm` files have their embedded payloads parsed — classic and `type="module"` `<script>` bodies with node's `vm` parser under the matching goal, JSON script types (`ld+json`, `importmap`, `speculationrules`, `+json`) with `JSON.parse`, and `<style>` rules with the same `lightningcss` parser as `.css` files — enumerated by the bundled `jsdom` package; external `src` scripts, inert `type` values, empty bodies and `<noscript>` scripts are skipped, `<template>` content is checked, `test/fixtures/` markup is exempt, the step prints `SKIP` when `jsdom` is not installed, and `<style>` payloads warn-skip when `lightningcss` cannot be resolved through vite. Every changed text file is then scanned for leftover git merge-conflict markers — lines starting with `<<<<<<<`, `|||||||` or `>>>>>>>` at column 0, the artifacts a botched resolution leaves behind; the per-type grammars cannot see them inside strings, comments and template literals, and file types with no parser never reject them. Binary files (a NUL byte in the first 8 KiB) and files over 64 MiB are skipped, `test/fixtures/` payloads are exempt because fixtures may legitimately embed marker text as test input, and only column 0 counts so indented examples stay content. Extensionless executables are checked by their shebang interpreter: `python3`, `bash -n` for `sh`/`bash`/`dash`, `perl -c`, or `node --check`. Other interpreters, such as `zsh`, stay unchecked.
8. **Runs the quarantine-ledger check** (`scripts/check-quarantine-ledger.mjs --base <merge-base>`) when a `*.test.*` or `*.spec.*` file or `queue/quarantine.tsv` changed.
9. **Runs two lane lints when their inputs changed**: the real-I/O lane membership check (`scripts/check-realio-lane-membership.mjs`) and `scripts/check-verse-sync-io.mjs`. The real-I/O check reads every `test/**/*.test.ts` file for spawn/server markers against the lane manifests and allowlist, and fails only for files your diff changed; violations in unchanged files print a `WARN`. It runs when the diff touches a `test/**/*.test.ts` path — deletions included, since removing a member file can stale the manifest — or one of its other inputs: `test/config/realio-lane-membership.mjs`, `test/config/serial-cpu-lane-membership.mjs`, `scripts/realio-lane-inventory.mjs`, `scripts/realio-lane-known-fast-spawns.mjs` or the checker itself. The verse check reads every `*-api.ts` under `src/core/verse/` and runs when the diff touches one of those route files or `scripts/check-verse-sync-io.mjs`. A diff touching neither input set prints `PASS … skipped` for both, sparing the ~2 s of full-tree scans.
10. **Type-checks the `contrib/router` program**: the Ashlr issue→PR router supervisor runs under `tsx`, which transpiles without checking types, and no `tsconfig` project covers `contrib/router/` (the backend project includes only `src/`; ESLint still lints the files but cannot type-check them). When a `.ts` file under `contrib/router/`, `src/core/authority/protected-paths.ts` — the program's only source-tree import — or `package.json`/`package-lock.json` changed, it takes a typecheck slot and runs the `tsc --noEmit` file-list invocation `contrib/router/SUPERVISOR.md` documents against every top-level `contrib/router/*.ts` file; tsc follows the `src/` import on its own, and the child gets a 4 GB heap ceiling because the import closure peaks near 1.5 GB. With no installed `typescript` package the step prints `SKIP`.
11. **Type-checks only the projects the diff touches**: the backend project (`tsconfig.json`) when a changed path is a root `tsconfig*.json` or sits under `src/` (outside `src/web-ui/` and `src/raycast/`), `test/` or `scripts/`; the web project (`src/web-ui/tsconfig.json`) when a path under `src/web-ui/` changed; the desktop project (`desktop/tsconfig.json`) when a path under `desktop/` changed or when `src/web-ui/tsconfig.json` — the config the desktop project extends — changed; all three when `package.json` or `package-lock.json` changed. A diff that touches none, such as a docs-only change, skips the step. Otherwise it takes one machine-wide typecheck slot (see "Typecheck slots" below) and runs `node_modules/.bin/tsgo --noEmit --incremental` for each selected project when that binary is installed. Without `tsgo`, or if it crashes, it falls back to `tsc` with the same flags; the backend fallback also uses the shared build-info cache described below. Each project keeps its incremental build info in the worktree, at `.ashlr-gate/verify/backend.tsbuildinfo`, `.ashlr-gate/verify/web.tsbuildinfo` and `.ashlr-gate/verify/desktop.tsbuildinfo` (`.ashlr-gate/` is gitignored).
12. **Records the pass**: on success the fingerprint is written as a marker so a later identical state skips the run.

A missing local tool never fails the run. The docs check and ESLint print
`SKIP … run npm ci to restore it` when their packages are absent, and each
syntax check prints `SKIP` when its tool or parser package is unavailable.
Run `npm ci`, then `node scripts/verify-changed.mjs --force`.

When authority drift fails, run `npm run authority:regen`, review the summary and generated changes, and list each new Tier-1 root in the PR body for CODEOWNERS review.

For what each failing step means and how to fix it, see
[Reading `verify-changed` output](CONTRIBUTE-WITH-AN-AGENT.md#reading-verify-changed-output).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PHANTOM_TSC_CACHE_DIR` | `<git-common-dir>/phantom-tsc-cache` | Directory that holds the shared incremental build-info cache across worktrees. |
| `PHANTOM_TSC_SLOTS` | `3` | Machine-wide cap on concurrent typechecks, shared across worktrees through the git common dir. Must be an integer from 1 to 64. |
| `PHANTOM_TSC_TIMEOUT_SECONDS` | `900` (15 min) | Hard timeout (seconds) for each `tsgo`/`tsc --noEmit` run, which is killed with `SIGKILL` when it exceeds it; also bounds the wait for a typecheck slot (`FAIL tsc slot wait`). |
| `PHANTOM_VERIFY_PASSED_DIR` | `<git-common-dir>/phantom-verify-passed` | Directory holding one marker file per passed state, shared across worktrees. |
| `PHANTOM_VERIFY_FORCE` | unset | Truthy (`1`, `true`, `yes`, `on`) reruns verify instead of skipping an already-passed state; identical to `--force`. |

## Pass dedupe

The fingerprint combines the real git tree hash of the working state (a private copy of the index is updated with `git add -A` and hashed by `git write-tree`, so committed, staged, unstaged and untracked non-ignored content all count and the real index is untouched), the `origin/master` merge-base (changed-file selection depends on it; without one, `status:` plus the `HEAD` commit), and the installed checker identities (eslint/typescript versions, tsgo presence, Node version, platform) whose drift can change a verdict on an identical tree.

Each pass stores `<sha256-of-inputs>.json` under the marker directory — shared across worktrees through the git common dir — and markers are pruned to the newest 256. A corrupt marker counts as a miss; `--force` and `PHANTOM_VERIFY_FORCE` bypass the skip (a forced pass still records). If fingerprinting fails (for example when git cannot hash the working tree), verify prints `WARN verify dedupe unavailable`, runs normally and records nothing.

## Where the shared cache lives

The shared build-info cache serves only the backend `tsc` fallback; `tsgo` and the web check use only the worktree-local file. Before that fallback runs, the shared file is copied to `.ashlr-gate/verify/backend.tsbuildinfo`; after a pass, the local file is copied back.

The shared cache file path is derived from a SHA-256 hash of the `package-lock.json` length + `package-lock.json` content + `tsconfig.json` content:

```
<PHANTOM_TSC_CACHE_DIR>/<sha256>.tsbuildinfo
```

If `PHANTOM_TSC_CACHE_DIR` is unset, the cache lives under the repository's git common directory (accessible via `git rev-parse --git-common-dir`), i.e. `.git/phantom-tsc-cache/<hash>.tsbuildinfo` in a normal single-repo checkout.

## Typecheck slots

A typecheck takes one slot by atomically creating `phantom-tsc-slots/slot-<n>` beside the shared cache root and writing its pid inside. Worktrees of the same repo share the slots through the git common dir, so at most `PHANTOM_TSC_SLOTS` typechecks run machine-wide at once. When every slot is held the check polls until one frees — bounded by `PHANTOM_TSC_TIMEOUT_SECONDS` — and a slot whose recorded pid no longer exists is reclaimed. The slot is always released: success, failure, timeout, and signal exits all free it.
