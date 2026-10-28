# Documentation freshness

Run from the checkout with Node 22.15 or newer:

```sh
node scripts/freshness/sync.mjs
node scripts/freshness/check.mjs
HOME=$(mktemp -d) node --test scripts/freshness/sync.test.mjs
```

Both commands accept `--root directory` for isolated fixtures. Check is read-only
and exits 1 on drift or invalid input. Sync validates all documents before writing.
No network, credentials, dependencies or workflow changes are needed.

The package version is the source candidate identity. The first dated release
heading in CHANGELOG.md supplies the released version and date; Unreleased
sections are skipped. A dated changelog entry does not prove npm promotion.
Generated install text reminds readers to verify availability.

Managed Markdown blocks use `<!-- fresh:begin NAME -->` and
`<!-- fresh:end -->` on separate lines. Supported names:

| Name | Generated content |
| --- | --- |
| `version-badge` | Source candidate badge |
| `install-snippet` | Exact released npm install and version check |
| `version-table` | Candidate and latest dated changelog release |
| `example-version-pin` | Exact released npx example |

Only marked content in README.md, CHANGELOG.md and Markdown files recursively
under docs/ and examples/ is regenerated. Symlinks, hidden directories and
node_modules are excluded. Historical sections and unmarked examples stay intact.
Unknown names and malformed or unbalanced markers fail closed.

This complements `npm run check:docs` (documentation navigation),
`npm run check:version` (candidate metadata), and scripts/check-version.mjs
(release tag identity). It does not duplicate or replace those checks.

The task prohibits Tier-1 changes, including package.json. Direct invocations
above are the available interface. An owner can later add `fresh:sync` and
`fresh:check` npm aliases pointing at these scripts, without changing workflows.
