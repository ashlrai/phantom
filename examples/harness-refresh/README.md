# Offline harness refresh worklist

This example turns a local harness digest into a review queue. From the
repository root (Node 22.15+ and installed dependencies), provide both the
digest path and the UTC calendar date to use as the clock:

```sh
npx tsx examples/harness-refresh/worklist.ts /path/to/digest.md 2026-10-31 > worklist.json
```

For a self-contained offline trial, write a fictional digest to a temporary
file and use that path instead:

```sh
trial_dir=$(mktemp -d)
cat > "$trial_dir/digest.md" <<'DIGEST'
# Harness learning

## S1 — Fictional evaluation
- Checked: 2026-10-20.
- Source: [Example](https://example.test/evaluation).
- Evidence: A fictional team checks its examples.
DIGEST
npx tsx examples/harness-refresh/worklist.ts "$trial_dir/digest.md" 2026-10-31
```

The JSON includes `asOf`, `staleDays` (7), and `worklist`. Each item has a
source `id`, its unique HTTPS `urls`, and `reasons`: `stale`, `undated`, and/or
`issue:<reader code>`. A source checked exactly seven UTC calendar days ago is
fresh. Missing, invalid, and future check dates are undated; their reader issue
explains why. Any reader issue linked to an ID includes that ID in the queue,
even when its date is fresh. Duplicate IDs are combined in first-seen order:
URLs and reasons are unions across all entries with that ID, so review every
entry before resolving a duplicate. Issues whose IDs have no parsed source are
reported separately in `unmatchedIssues`; they need manual repair. Sources
without usable URLs remain in the queue when they have a reason.

The digest reader accepts source sections headed `## S1 — Title`, dates on
`- Checked: YYYY-MM-DD.` lines, and HTTPS Markdown links on `- Source:` lines.
It reads a stable regular file of at most 1 MiB. The example treats the digest
and URLs as data: it neither executes source text nor fetches links. Invalid
arguments or unreadable files fail with a nonzero exit and no JSON output.

A leader can review the reasons and prioritize sources for research. The JSON
is a worklist, not verified research or an instruction to visit a URL. Using its
own approved research process, the leader should verify each claim and date,
check the source's license and permitted use, and record the original source
URL, author or organization, title, and any required license attribution with
its findings. It can then add the verified evidence, citations, and new checked
date to its own digest, resolving malformed or duplicate IDs there. Rerun this
example against that digest with an explicit date to see what still needs
attention; the example never edits the digest itself.
