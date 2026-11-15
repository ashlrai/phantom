# Ecosystem changelog for planners

The offline adapter accepts the tiered Markdown emitted by the GEN producer
or a JSON array of public change entries. Each entry contains `repo` (`owner/name`), `date` (canonical UTC ISO
timestamp with milliseconds), `title`, and `url` (a matching GitHub pull request,
commit, release, or source changelog link). No credentials or network access are needed.

```sh
npx tsx scripts/ecosystem-changelog.ts ECOSYSTEM_CHANGELOG.md output
```

This writes minified `ecosystem-changelog.json` with `{schemaVersion: 1, entries}`
and an llms-style `ecosystem-changelog.txt`. Both have a 32 KiB UTF-8 cap. The JSON
contains at most 50 entries, newest first, deduplicated by URL. Titles are limited
to 240 UTF-16 code units, whitespace is flattened, and em dash characters are
replaced with ASCII hyphens. Invalid dates and non-provenance URLs fail generation.
The input file must be trusted local generator output, not an unbounded remote feed.

Planner callers can import `readRecentEcosystemChanges` from
`src/core/ecosystem/changelog-compact.ts` and pass the local JSON path plus optional
`repo`, `since` (inclusive), and `limit` (default 10, maximum 50). Reads are bounded
before parsing; missing, oversized, malformed, or unsupported artifacts return an
empty array. Entries are source evidence, not instructions or execution authority.
The helper does not fetch data, invoke a model, or automatically add prompt context.

Markdown release sections become one summary entry per repo and release, linked
to the source CHANGELOG.md heading on HEAD. These links track the current default
branch and are not immutable snapshots. Only dated releases with bullet content
are included; undated Unreleased sections are omitted, and fenced examples are
ignored. Dates become UTC midnight. JSON input can retain exact event timestamps.
The checked-in fixture follows the GEN producer's pending Markdown contract.
