# Docs autosync (daily run)

`scripts/docs-autosync.mjs` keeps every reference doc that is generated from
source byte-identical to the checkout it describes. It is the sanctioned
replacement for hand-run regeneration: one command covers all three managed
docs, so a post-merge docs refresh cannot update one file and forget another.

## Managed docs

| Doc | Source of truth | Generator |
| --- | --- | --- |
| `docs/cli.md` | `phm --help` and `phm help --all` output | `scripts/generate-cli-docs.mjs` |
| `docs/CLI-REFERENCE.md` | `phm --help` and `phm help --all` output | `scripts/generate-cli-reference.ts` |
| `docs/CONFIG-REFERENCE.md` | `schema/config.schema.json` | `scripts/generate-config-docs.mjs` |

Each generator also runs standalone with the same contract: bare invocation
rewrites its doc, `--check` compares without writing.

## The step

Run from the repository root of a current master worktree:

```sh
node scripts/docs-autosync.mjs            # rewrite stale generated docs in place
node scripts/docs-autosync.mjs --check    # verify only; exit 1 naming stale docs
node scripts/docs-autosync.mjs --list     # print the managed doc paths
node scripts/docs-autosync.mjs --json     # machine-readable per-doc status
```

Statuses are `fresh`, `stale`, `written` and `error`. A failing doc reports
`error` with a one-line detail but never hides the other docs' results. Exit
codes: `0` all fresh or synced, `1` drift or generator error, `2` bad usage.

## Daily run and publication

The owning scheduler runs the bare command once a day in a master worktree
after the merge window:

- **No drift:** the run is a no-op — nothing is staged and no PR is opened.
- **Drift:** the regenerated docs remain uncommitted in the worktree, and the
  bridge commits and delivers them through a **normal pull request** — the
  existing sanctioned deploy path for this repository (see `AGENTS.md` and
  `docs/BRIDGE-WORKTREES.md`). The script itself never commits, pushes, opens
  PRs or reads credentials, and no other publish path exists for `docs/`.
- `--check` gives gates a cheap drift probe; `--list` gives tooling the exact
  path set to stage if a different publisher is ever approved.

Each bridge job that lands on master is itself the merge that can introduce
drift, so the daily cadence is the bound on staleness — not a correctness
gate. The drift guards (`test/cli-docs-drift.test.ts`,
`test/cli-reference-drift.test.ts`, `test/config-docs-drift.test.ts`) fail CI
on any missed regeneration regardless of when the daily job last ran.

## Manual equivalent

Anyone changing help text in `src/cli/` or the config schema regenerates the
affected doc directly (`node scripts/generate-cli-docs.mjs`,
`node --import tsx scripts/generate-cli-reference.ts`,
`node scripts/generate-config-docs.mjs`) or runs the umbrella command above.
