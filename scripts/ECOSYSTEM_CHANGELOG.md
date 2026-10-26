# Ecosystem changelog generator

Run from the Phantom checkout with Node 22.15 or newer:

```sh
node scripts/generate-ecosystem-changelog.mjs /path/to/repos
```

The input root must contain all seven sibling directories, each with a
`CHANGELOG.md`: phantom; phantom-secrets and locus; ashlr-md, ashlr-stack,
lexicon and ashlr-plugin. These are rendered as tiers 1, 2 and 3 in that exact
order. All release sections are included in source order, including Unreleased.
Each input must have a level-two release heading and release content. Introductory
text is omitted; fenced code is preserved. Em dashes become ASCII hyphens.

The default output is `ECOSYSTEM_CHANGELOG.md` in the current directory. An
optional second argument selects a different output file. Generation reads all
inputs and validates them before writing. It makes no network requests, reads no
credentials, and does not publish or tag anything. It rejects an output path that resolves to an input changelog.

Bare `#123` references become PR links in the current repo. `locus#123` and
`ashlrai/locus#123` become links in that repo. Existing Markdown links, URLs and
inline or fenced code remain intact. Bare numbers are treated as PR references;
use an explicit Markdown issue link for issues. An entry receives `[cross-repo]`
when it references another of the seven repos using a qualified number or GitHub
URL. Authors may also mark coordinated changes explicitly with `[cross-repo]`.
This flag records a changelog statement, not dependency analysis or approval.

The representative fixtures are offline examples, not live release claims:

```sh
node scripts/generate-ecosystem-changelog.mjs test/fixtures/ecosystem-changelog /tmp/ECOSYSTEM_CHANGELOG.md
HOME=$(mktemp -d) npx vitest run test/ecosystem-changelog.test.ts
```

The checked-in expected fixture establishes byte-for-byte formatting, ordering,
PR and repo links. No timestamp, filesystem ordering or Git metadata enters output.
