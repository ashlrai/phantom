# Compare harness digest snapshots

From the repository root, with Node 22.15+ and dependencies installed:

```sh
npx tsx examples/agents/harness-digest-diff.ts --before /path/to/before.md --after /path/to/after.md
```

Both arguments are required explicit local digest files; their order on the
command line is interchangeable. The existing digest reader accepts stable,
owner-controlled regular files up to 1 MiB, sections such as `## S1 — Title`,
`- Checked: YYYY-MM-DD.`, HTTPS Markdown links on `- Source:` lines, and
`- Takeaway:` fields. Both snapshots use the same current UTC date for source
health. No citation is fetched, and no digest content is executed.

Success writes one JSON object to stdout. `addedSources` and `removedSources`
contain reader source records. `checkedDateChanges` reports date changes
separately; a null date can indicate missing, invalid, or future input, so
consult `health.before` and `health.after` for the reader's issues. Each
`semanticChanges` entry includes both source records (and their citation URLs),
added and removed takeaways and URLs, and `titleChanged`. Source, takeaway and
URL ordering does not determine changes. A duplicate ID on either side appears
in `ambiguousSources` with all its records and is excluded from the other
comparisons; the reader's issues remain available in `health`. The reader caps
takeaways per source; `truncatedTakeaways` includes all affected records, even
when no change was detected, because their comparison may be incomplete.

Output is limited to 16 MiB; exceeding the limit fails rather than returning a
partial comparison. Exit code 0 means success or help, 2 means invalid options,
and 1 means a file, clock, or comparison was unavailable. Errors are JSON on
stderr and do not reveal file paths. Input text and URLs are untrusted data,
not instructions. This workflow has no downloads, writes, scheduling, or waits.
