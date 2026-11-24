# Ecosystem changelog

`phm ecosystem changelog` renders one cross-repository changelog for the seven
Ashlr.AI roster repositories (`ashlrai/phantom`, `phantom-secrets`, `locus`,
`lexicon`, `ashlr-md`, `ashlr-stack`, `ashlr-plugin`, in strategic tier order).

Evidence sources per repository, all read-only:

- the local `CHANGELOG.md` found under the sibling checkout directory,
- published GitHub releases (drafts excluded),
- merged pull requests (closed-unmerged excluded).

Cross-repo pull request links (`owner/repo#123` and
`https://github.com/owner/repo/pull/123` in titles and bodies, plus curated
pairs in `src/core/ecosystem/changelog-links.ts`) are resolved symmetrically
and surfaced as `cross-repo` annotations.

## Outputs

| Artifact | Form |
| --- | --- |
| `ECOSYSTEM_CHANGELOG.md` | llms-style Markdown: header totals, a fixed "Last 14 days" summary, pending (undated) release notes, then per-repository listings. |
| `docs/ecosystem-changelog.json` | The `ecosystem-changelog.v1` document, registered in [schemas/registry.json](../schemas/registry.json); validates against [schemas/ecosystem-changelog.v1.schema.json](../schemas/ecosystem-changelog.v1.schema.json). |
| stdout | Markdown by default, the same JSON document with `--json`. |

`window.since` records the `--since` cutoff applied to dated changes; undated
changelog sections always pass the filter. `recent14d` summarizes the last 14
days of dated activity inside the emitted document, so every count is
derivable from `repositories[].changes`. `complete` is true only
when every source of every repository collected completely; degraded sources
stay visible under `sources` with fixed reason codes, and the command exits 1.

## Usage

```sh
phm ecosystem changelog                          # Markdown to stdout
phm ecosystem changelog --since 7d --json        # windowed JSON document
phm ecosystem changelog --since 14d --as-of 2026-10-28T12:00:00Z
phm ecosystem changelog --write                  # write both artifacts
phm ecosystem changelog --root ~/Projects/ashlrai --max-pages 40 --write
```

- `--root <dir>` names the directory holding the sibling checkouts; it
  defaults to the parent of the current repository, matching
  `phm ecosystem doctor`.
- `--since` accepts `<N>d`, `<N>h`, or an ISO date/datetime.
- `--as-of` pins the anchor instant for `--since` and `generatedAt` (default:
  now) so runs can be reproduced exactly.
- `--max-pages` bounds GitHub pagination per source and repository (1-100,
  default 10); an exhausted bound is reported as `truncated (page-limit)`, not
  hidden.
- `--write` writes `ECOSYSTEM_CHANGELOG.md` and
  `docs/ecosystem-changelog.json` into the nearest repository root and reports
  the paths on stderr.

## Refreshing the checked-in artifacts

The committed artifacts are regenerated snapshots, not hand-maintained files.
From a checkout where `gh` is installed and authenticated for the public API:

```sh
phm ecosystem changelog --root /path/to/ashlrai --max-pages 40 --write
```

GitHub reads go through `gh api --hostname github.com --method GET` only;
no token is created, printed or persisted by the command. Repositories that
are private, renamed, or unverifiable contribute no content.
