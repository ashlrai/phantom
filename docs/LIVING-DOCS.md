# Living docs sync (`scripts/docs-sync.mjs`)

Several committed files are generated from the repository itself: CLI help
output, the docs page index, the source directory map and the changelog's
merged-PR block. Each already has a drift guard in `test/`; the sync is the
single writer that regenerates all of them in one pass, so doc updates that
trail merged PRs can be proposed as one reviewable diff.

Copy-paste from the repository root:

```sh
node --import tsx scripts/docs-sync.mjs            # plan: report fresh/stale, write nothing
node --import tsx scripts/docs-sync.mjs --check    # exit 1 when any surface is stale or fails
node --import tsx scripts/docs-sync.mjs --write    # regenerate the stale files
node --import tsx scripts/docs-sync.mjs --json     # machine-readable report for a publishing lane
```

`--import tsx` is required because the CLI-REFERENCE renderer lives in
TypeScript — the same invocation `scripts/generate-cli-reference.ts` documents.

## Surfaces

| Surface | File | Generated from | Drift guard |
| --- | --- | --- | --- |
| `cli` | `docs/cli.md` | `phm --help` and `phm help --all`, captured in a throwaway HOME | `test/cli-docs-drift.test.ts` |
| `cli-reference` | `docs/CLI-REFERENCE.md` | the same two captures | `test/cli-reference-drift.test.ts` |
| `llms` | `docs/llms.txt` | the generated page index block (`scripts/lib/docs-pages.mjs`) | `test/docs-llms-txt.test.ts` |
| `codemap` | `docs/CODEMAP.md` | sorted `src/` and `src/core/` directory listings (`scripts/lib/codemap.mjs`) | `test/codemap-drift.test.ts` |
| `changelog` | `CHANGELOG.md` | the `<!-- changelog-sync -->` block inside `## [Unreleased]` (`scripts/changelog-sync.mjs`) | `test/changelog-sync.test.ts` |

The two CLI surfaces share one pair of captures — `phm` runs twice per sync,
not four. Manual text around generated blocks is preserved; the sync only ever
rewrites the regions each generator owns.

Restrict the run with `--surface <name>` (repeatable or comma-separated), and
point at another checkout with `--root <dir>`.

## Changelog evidence

The changelog surface delegates to `scripts/changelog-sync.mjs` and needs the
same scoped snapshot contract documented in
[scripts/CHANGELOG-SYNC.md](../scripts/CHANGELOG-SYNC.md):

```sh
node --import tsx scripts/docs-sync.mjs --changelog-snapshot snapshot.json   # PR titles + numbers
node --import tsx scripts/docs-sync.mjs --changelog-base <40-hex-sha>        # local commits only
```

With neither flag the sync anchors on the most recent release tag
(`git describe --tags --abbrev=0`), so "merged since the last release" works
offline — entries then carry commit subjects only, not PR titles or numbers.
No tag, snapshot or base means the surface reports `skipped`, not an error.

First adoption note: a changelog without `<!-- changelog-sync -->` markers
keeps its handwritten Unreleased entries and gets the generated block appended
after them. Pruning the overlap is a one-time review step, after which the
block owns the section's generated entries. `changelog-sync verify` still
requires every release tag to name exactly one changelog section; only the
`update` path tolerates Phantom's historical repeated `## [Unreleased] — M<N>`
milestone headings (and resolves them to the first, live section).

## Report and PR proposal

`--json` prints:

```json
{
  "ok": false,
  "mode": "plan",
  "surfaces": [
    {"name": "codemap", "path": "docs/CODEMAP.md", "status": "stale",
     "bytesBefore": 100, "bytesAfter": 120,
     "firstDifference": {"line": 89, "actual": "...", "expected": "..."}}
  ],
  "proposal": {"title": "…", "body": "…"}
}
```

Per-surface `status` is `fresh`, `stale`, `written`, `skipped` (inputs
unavailable, with `detail`) or `error` (the generator failed). `ok` is false
when anything is stale or errored. When a sync would change or did change a
file, `proposal` is a ready `{title, body}` for the PR a publishing lane
opens — this command never commits, pushes or calls GitHub.

## Boundaries

Local reads and writes only: no network (a `--changelog-snapshot` file is
produced elsewhere by the authorized transport), no credentials, no pushes,
no PR creation. Help captures run through `tsx` against `src/cli/index.ts` in
a disposable HOME, matching `scripts/generate-cli-docs.mjs`.
