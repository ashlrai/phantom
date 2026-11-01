# Changed-files verification (`scripts/verify-changed.mjs`)

Run the local pre-merge check from the repository root:

```
node scripts/verify-changed.mjs
```

## What it does

1. **Collects changed paths** — committed, staged, unstaged, and untracked files diffed against `origin/master`.
2. **Selects lintable files** — existing `.js`, `.mjs`, `.cjs`, `.ts`, `.cts`, `.mts`, `.tsx`, `.jsx` files still on disk.
3. **Runs ESLint** on the changed files (skipped silently if `node_modules/eslint` is absent — CI Merge Gate handles this).
4. **Runs `tsc --noEmit`** with incremental build-info caching and a **shared atomic cache** (works through a unique temporary file to avoid readers seeing partial writes).
5. **Runs `tsc --noEmit` on `src/web-ui/tsconfig.json`** only when a path under `src/web-ui/` is changed.
6. **Runs two lane/integrity scripts**: `scripts/check-realio-lane-membership.mjs` and `scripts/check-verse-sync-io.mjs`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PHANTOM_TSC_CACHE_DIR` | `<git-common-dir>/phantom-tsc-cache` | Directory that holds the shared incremental build-info cache across worktrees. |
| `PHANTOM_TSC_TIMEOUT_SECONDS` | `900` (15 min) | Hard timeout (seconds) for `tsc --noEmit`; writes that exceed it are killed with `SIGKILL`. |

## Where the shared cache lives

The shared cache file path is derived from a SHA-256 hash of the `package-lock.json` length + `package-lock.json` content + `tsconfig.json` content:

```
<PHANTOM_TSC_CACHE_DIR>/<sha256>.tsbuildinfo
```

If `PHANTOM_TSC_CACHE_DIR` is unset, the cache lives under the repository's git common directory (accessible via `git rev-parse --git-common-dir`), i.e. `.git/phantom-tsc-cache/<hash>.tsbuildinfo` in a normal single-repo checkout.
