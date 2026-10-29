# Reusable changelog template

Copy `cliff.toml`, `scripts/changelog-sync`, `scripts/changelog-sync.mjs`, and
this guide to another repository. Node 22+ and git are sufficient for sync.
The optional git-cliff config generates a standalone conventional-commit
changelog with the same groups; it does not overwrite the sync block.
No workflow, package manifest, release publisher, or credentials are installed.

Run from the target repository root:

```sh
scripts/changelog-sync update --snapshot snapshot.json > preview.md
scripts/changelog-sync update --snapshot snapshot.json --write
scripts/changelog-sync verify --snapshot snapshot.json
```

Update defaults to a dry run. It selects the first heading marked Unreleased,
preserves manual text and historical sections, and replaces only its generated
HTML comment block. Missing or malformed headings and markers fail closed.
Conventional PR titles and direct commit subjects become Added, Fixed,
Performance, Reverted, or Changed entries. An exclamation mark records a breaking
change. Non-conventional subjects are omitted. PR merge and constituent commit
OIDs suppress duplicate commit entries. Use conventional titles for merged PRs.

Obtain a complete snapshot through the repository's authorized GitHub read
transport (Locus in Ashlr), with pagination exhausted and no token values in the
file. See `test/fixtures/changelog-sync/snapshot.json` for a complete offline
example. Scope `pullRequests` to merged PRs on the target branch since the base
release, including `number`, `title`, `mergedAt`, `mergeCommit.oid`, and optional
`commits: [{"oid": "..."}]`. Scope `commits` to the same range, oldest first,
with `oid` and single-line `message` subjects. Alternatively omit `commits` and
provide `base`, a full 40-character local commit SHA, to read base..HEAD with git.
No network request or credential discovery occurs in the script.

Verification requires `releases`, containing `tagName`, `body`, and `isDraft`,
and all release `tags` as strings. Omit `tags` to read all local tags; fetch a
complete tag history through the authorized transport first. Every supplied tag
must have exactly one non-draft release and one nonempty matching changelog
section. Only outer whitespace and CRLF are normalized; content drift fails.
An empty tag inventory fails. Non-release tags should be excluded explicitly in
the snapshot. Snapshot completeness and branch/range scoping are the exporting
transport's responsibility; offline verification cannot authenticate a snapshot.
The script never edits GitHub releases or creates tags.

Run the fixture test with an isolated home:

```sh
HOME=$(mktemp -d) npx vitest run test/changelog-sync.test.ts
```

Owner workflow wiring and publication are separate changes. No publish helper
is included or invoked by this template.

For a standalone preview using an already installed git-cliff binary:

```sh
git cliff --config cliff.toml --unreleased
```

This optional preview does not perform PR deduplication. The sync command adds
PR references from the snapshot and owns only its marked block. Review generated
Markdown before writing it; PR titles and commit subjects are repository content.
