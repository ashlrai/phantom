# Changed-files verification (`scripts/verify-changed.mjs`)

Run the local pre-merge check from the repository root:

```
node scripts/verify-changed.mjs
```

Pass `--force` (or set `PHANTOM_VERIFY_FORCE`) to rerun a state that already passed.

## What it does

0. **Skips already-passed states** — before any check it fingerprints the working tree (see "Pass dedupe" below) and exits 0 with `SKIP verify-changed` when that exact state previously passed.
1. **Collects changed paths** — committed, staged, unstaged, and untracked files diffed against `origin/master`.
2. **Selects lintable files** — existing `.js`, `.mjs`, `.cjs`, `.ts`, `.cts`, `.mts`, `.tsx`, `.jsx` files still on disk.
3. **Runs ESLint** on the changed files (skipped silently if `node_modules/eslint` is absent — CI Merge Gate handles this).
4. **Takes one machine-wide typecheck slot** (default 3, `PHANTOM_TSC_SLOTS` overrides) before running `tsc --noEmit` with incremental build-info caching and a **shared atomic cache** (works through a unique temporary file to avoid readers seeing partial writes).
5. **Runs `tsc --noEmit` on `src/web-ui/tsconfig.json`** only when a path under `src/web-ui/` is changed.
6. **Runs two lane/integrity scripts**: `scripts/check-realio-lane-membership.mjs` and `scripts/check-verse-sync-io.mjs`.
7. **Records the pass** — on success the fingerprint is written as a marker so a later identical state skips the run.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PHANTOM_TSC_CACHE_DIR` | `<git-common-dir>/phantom-tsc-cache` | Directory that holds the shared incremental build-info cache across worktrees. |
| `PHANTOM_TSC_SLOTS` | `3` | Machine-wide cap on concurrent typechecks, shared across worktrees through the git common dir. |
| `PHANTOM_TSC_TIMEOUT_SECONDS` | `900` (15 min) | Hard timeout (seconds) for `tsc --noEmit`; writes that exceed it are killed with `SIGKILL`. |
| `PHANTOM_VERIFY_PASSED_DIR` | `<git-common-dir>/phantom-verify-passed` | Directory holding one marker file per passed state, shared across worktrees. |
| `PHANTOM_VERIFY_FORCE` | unset | Truthy (`1`, `true`, `yes`, `on`) reruns verify instead of skipping an already-passed state; identical to `--force`. |

## Pass dedupe

The fingerprint combines the real git tree hash of the working state (a private copy of the index is updated with `git add -A` and hashed by `git write-tree`, so committed, staged, unstaged and untracked non-ignored content all count and the real index is untouched), the `origin/master` merge-base (changed-file selection depends on it), and the installed checker identities (eslint/typescript versions, tsgo presence, Node version, platform) whose drift can change a verdict on an identical tree.

Each pass stores `<sha256-of-inputs>.json` under the marker directory — shared across worktrees through the git common dir — and markers are pruned to the newest 256. A corrupt marker counts as a miss; `--force` and `PHANTOM_VERIFY_FORCE` bypass the skip (a forced pass still records). If fingerprinting fails (for example a repo without `origin/master`), verify runs normally and nothing is recorded.

## Where the shared cache lives

The shared cache file path is derived from a SHA-256 hash of the `package-lock.json` length + `package-lock.json` content + `tsconfig.json` content:

```
<PHANTOM_TSC_CACHE_DIR>/<sha256>.tsbuildinfo
```

If `PHANTOM_TSC_CACHE_DIR` is unset, the cache lives under the repository's git common directory (accessible via `git rev-parse --git-common-dir`), i.e. `.git/phantom-tsc-cache/<hash>.tsbuildinfo` in a normal single-repo checkout.

## Typecheck slots

A typecheck takes one slot by atomically creating `phantom-tsc-slots/slot-<n>` beside the shared cache root and writing its pid inside. Worktrees of the same repo share the slots through the git common dir, so at most `PHANTOM_TSC_SLOTS` typechecks run machine-wide at once. When every slot is held the check polls until one frees — bounded by `PHANTOM_TSC_TIMEOUT_SECONDS` — and a slot whose recorded pid no longer exists is reclaimed. The slot is always released: success, failure, timeout, and signal exits all free it.
