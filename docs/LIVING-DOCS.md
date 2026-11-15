# Living docs sync (`scripts/docs-sync.mjs`)

Several committed files are generated from repository state — `package.json`,
CHANGELOG.md headings, the `src/` layout, the CLI's own help output and the
`site/` tree. Each surface has its own generator and drift guard; the sync
runs them all in one pass, so a merged PR that bumps a version, adds a
`src/core` directory or renames a command never leaves a stale doc behind.

Copy-paste from the repository root:

```sh
node scripts/docs-sync.mjs            # regenerate every surface
node scripts/docs-sync.mjs --check    # report drift, write nothing, exit 1
node scripts/docs-sync.mjs --local    # skip the subprocess (CLI) generators
node scripts/docs-sync.mjs --json     # machine-readable report
node scripts/docs-sync.mjs --root dir # operate on another checkout or fixture
node scripts/docs-sync.mjs --only codemap,docs-llms   # restrict the run
```

## Surfaces

Local surfaces regenerate in-process:

| Surface id | Files | Generated from | Drift guard |
| --- | --- | --- | --- |
| `markdown-freshness` | `fresh:` blocks in README.md, CHANGELOG.md, docs/, examples/ | package.json version, install snippet, example pin | `test/freshness-*.test.ts` |
| `site-freshness` | `fresh:` blocks in `site/*.html` + command lines the pages show | the real dispatch switch, verb tables and `src/` flags | `test/site-freshness*.test.ts` |
| `codemap` | `docs/CODEMAP.md` | sorted `src/` and `src/core/` directory listings (`scripts/codemap.mjs`) | `test/codemap-drift.test.ts` |
| `docs-llms` | `docs/llms.txt` | generated page index block (`scripts/lib/docs-pages.mjs`) | `test/docs-llms-txt.test.ts` |
| `site-llms` | `site/llms.txt`, `site/llms-full.txt` | `scripts/generate-site-llms.mjs` | `test/site-llms*.test.ts` |

External surfaces delegate to their own generators, which rerun the CLI's
help output through `tsx` in a disposable HOME (slow; `--local` skips them):

| Surface id | File | Generator | Drift guard |
| --- | --- | --- | --- |
| `cli-docs` | `docs/cli.md` | `scripts/generate-cli-docs.mjs` | `test/cli-docs-drift.test.ts` |
| `cli-reference` | `docs/CLI-REFERENCE.md` | `scripts/generate-cli-reference.ts` | `test/cli-reference-drift.test.ts` |

Deliberately out of scope: CHANGELOG.md release sections come from
release-please and the snapshot-scoped `scripts/changelog-sync.mjs`, and
`site/sitemap.xml` `<lastmod>` follows git commit dates
(`build-site-sitemap.mjs`), so neither is a deterministic source-of-truth
surface.

## Report

`--json` prints the per-surface ledger:

```json
{
  "ok": true,
  "surfaces": [
    {"id": "codemap", "status": "clean", "files": []}
  ]
}
```

Each surface reports `clean`, `drift`/`updated` (with the touched `files`)
or `error` (with `detail`). `ok` is false when anything drifted or errored;
`--check` exits 1 in that case and writes nothing.

## Boundaries

Local reads and writes only: no network, no credentials, no pushes, no PR
creation. The external CLI captures run through `tsx` against
`src/cli/index.ts` in a disposable HOME, matching
`scripts/generate-cli-docs.mjs`. `test/docs-sync.test.ts` holds the committed
tree to `--check --local`.
