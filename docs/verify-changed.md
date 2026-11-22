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
1. **Collects changed paths**: files committed since the `origin/master` merge-base, plus staged, unstaged and untracked (non-ignored) files. Renames count as a deletion and an addition. Without a merge base (no `origin/master`, or a shallow clone) it prints `WARN no merge base: using working-tree status and diff against HEAD` and checks only uncommitted changes, so committed work on the branch goes unchecked; `git fetch origin master` (or `git fetch --unshallow origin`) restores the full diff. It then prints one `verify: <n> changed files (<mode>), <scope>` line naming the type-check projects the diff selects (step 10).
2. **Refuses empty new tests**: a changed test file with no test in it fails the run.
3. **Checks the fleet registry** with `node scripts/gen-fleet-registry.mjs --check` when a `src/cli/fleet-*.ts` file changed. Fix it by running `node scripts/gen-fleet-registry.mjs` and committing the result.
4. **Checks authority drift** with the CODEOWNERS and Tier-1 closure suites when a changed path is under `src/`, `test/` or `scripts/`, or is `.github/CODEOWNERS`. If `origin/master` has moved since the branch forked, the suites run again on a temporary overlay of your changes on current master, so a combination that drifts fails here rather than after merge. Without a merge base that overlay run is skipped with a `WARN`; the local suites still run.
5. **Runs the documentation check** (`scripts/check-documentation.mjs`, the same check as `npm run check:docs`) when a `.md` file changed or any path was deleted.
6. **Runs ESLint** on changed `.js`, `.mjs`, `.cjs`, `.ts`, `.cts`, `.mts`, `.tsx` and `.jsx` files still on disk, with ESLint's own config and ignores.
7. **Syntax-checks other changed files**: `.py` with `python3`, `.sh` with `bash -n`, `.pl` with `perl -c` (compile only, the same grammar step CI's secret-shape job applies to `scrub.pl`), `.json`/`.webmanifest` with `JSON.parse`, `.xml`/`.plist`/`.plist.in`/`.svg` with `python3`'s ElementTree parser, `.rs` with `rustfmt`, `.swift` with `swiftc -parse`, `.yaml`/`.yml` with the bundled `yaml` package, `.toml` with `smol-toml`, `.css` with the `lightningcss` parser Vite bundles, `.snap` with node's script parser, and `.patch`/`.diff` with `git apply --stat` (the unified-diff grammar, without requiring the patch to apply in this checkout). Extensionless executables are checked by their shebang interpreter: `python3`, `bash -n` for `sh`/`bash`/`dash`, `perl -c`, or `node --check`. Other interpreters, such as `zsh`, stay unchecked.
8. **Runs the quarantine-ledger check** (`scripts/check-quarantine-ledger.mjs --base <merge-base>`) when a `*.test.*` or `*.spec.*` file or `queue/quarantine.tsv` changed.
9. **Runs two lane lints**: the real-I/O lane membership check and `scripts/check-verse-sync-io.mjs`. The real-I/O check fails only for files your diff changed; violations in unchanged files print a `WARN`.
10. **Type-checks only the projects the diff touches**: the backend project (`tsconfig.json`) when a changed path is a root `tsconfig*.json` or sits under `src/` (outside `src/web-ui/` and `src/raycast/`), `test/` or `scripts/`; the web project (`src/web-ui/tsconfig.json`) when a path under `src/web-ui/` changed; both when `package.json` or `package-lock.json` changed. A diff that touches neither, such as a docs-only change, skips the step. Otherwise it takes one machine-wide typecheck slot (see "Typecheck slots" below) and runs `node_modules/.bin/tsgo --noEmit --incremental` for each selected project when that binary is installed. Without `tsgo`, or if it crashes, it falls back to `tsc` with the same flags; the backend fallback also uses the shared build-info cache described below. Each project keeps its incremental build info in the worktree, at `.ashlr-gate/verify/backend.tsbuildinfo` and `.ashlr-gate/verify/web.tsbuildinfo` (`.ashlr-gate/` is gitignored).
11. **Records the pass**: on success the fingerprint is written as a marker so a later identical state skips the run.

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
