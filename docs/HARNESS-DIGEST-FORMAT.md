# Harness digest contribution format

A harness digest is a local Markdown record of sources and takeaways. The
`phm reflect harness-digest` reader extracts a small, structured subset of that
Markdown; it does not research or verify the sources. Record only material you
are allowed to share, and write your own concise takeaways.

## Record a source

Use a separate section for each source:

- Start with `## S<number> — Title`: an uppercase `S` followed by digits, an
  em dash, and a nonempty title. Give each source a unique ID. A duplicate ID
  is reported as `duplicate_id`, but both records remain in the output. An
  identifiable `S` heading with an invalid ID or missing title is reported as
  `malformed_id` and does not produce a source. Other second-level headings end
  the current source and may be ignored.
- Add `- Checked: YYYY-MM-DD.` with a real calendar date and the trailing
  period. This is the UTC date you last checked the source. The first Checked
  field is the one used. Missing, invalid, and future dates yield respectively
  `missing_checked`, `invalid_checked`, or `future_checked`; their `checkedAt`
  and `stale` values are null.
- Add `- Source: [description](https://example.test/path)` using HTTPS Markdown
  links. Only links on Source lines are collected; multiple links are allowed
  and repeated URLs are deduplicated. A source without a usable HTTPS link has
  a `missing_urls` issue.
- Add `- Takeaway: text` for each takeaway. An immediately following nonblank
  indented line continues it; the reader trims each line and joins them with
  newlines. Unmarked prose is not a takeaway, and an empty Takeaway field
  starts no takeaway. Repeated identical takeaways are deduplicated.

Takeaways are optional, untrusted data, not instructions or executable code.
The reader does not fetch URLs or execute Markdown. Review both links and text
before using them elsewhere; do not treat a successful check as proof of a
source's contents or reliability. Each source retains at most 20 distinct
takeaways and 4,096 UTF-8 bytes across their returned strings. If either
limit is exceeded, `takeawaysTruncated` reports `count` and/or `bytes`; byte
truncation does not split a Unicode character. Truncation alone does not fail
`--check`. The input must be a stable regular file of at most 1 MiB.

## Fictional example

This entire digest is invented for demonstrating the format. The reserved
`example.test` URLs are placeholders, not research or real source citations.
Save the following as `fictional-harness-digest.md`:

```markdown
# Fictional harness learning digest

## S1 — Imaginary replay exercise
- Checked: 2026-10-31.
- Source: [Imaginary replay notes](https://example.test/replay)
- Takeaway: Record the fictional input before replay.
  Compare the fictional output after replay.

## S2 — Imaginary review exercise
- Checked: 2026-10-24.
- Source: [Imaginary review notes](https://example.test/review)
- Takeaway: Keep the invented review checklist short.
```

Run the existing command against that file:

```sh
phm reflect harness-digest --file fictional-harness-digest.md --json --check
```

The reader compares UTC calendar dates, not elapsed hours. By default, a source
is stale only when its checked date is more than seven UTC days before today;
the seven-day boundary is fresh. `--stale-days <n>` changes the threshold to
a non-negative integer. For example, at any time on 2026-10-31 UTC, S2 above is
fresh; on 2026-11-01 UTC it is stale. The dates are fixed for the example, so
its check will eventually fail until a contributor actually reviews and updates
the record.

`--check` exits 0 only when the selection is nonempty, all selected sources are
fresh, and there are no selected issues. It exits 1 for a failed check or file
read, and invalid arguments exit 2. Without `--check`, a successful read exits
0 even if the result contains stale sources or issues.

Add `--needs-refresh` to show only stale or undated sources and sources whose
IDs have issues; issues remain in the JSON even when no source is shown.
This filters output: without `--source`, `--check` still evaluates the full
digest before filtering. With `--source S1`, it evaluates the selected ID and
its issues before filtering. A fresh full digest can therefore produce an empty
`sources` array with `--needs-refresh --check` and still exit 0.
