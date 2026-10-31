# Harness refresh worklist

From the repository root, with Node 22.15+ and dependencies installed:

```sh
npx tsx examples/agents/harness-worklist.ts --file /path/to/digest.md
```

Use `npx tsx examples/agents/harness-worklist.ts --help` for usage. The input
is an explicit local digest in the format accepted by `readHarnessDigest`:
sections such as `## S1 — Title`, `- Checked: YYYY-MM-DD.`, and HTTPS Markdown
links on `- Source:` lines. The reader requires a stable, owner-controlled
regular file no larger than 1 MiB. It evaluates freshness against today's UTC
calendar date; dates over seven days old are stale.

On success stdout is JSON with `v: 1`, UTC `asOf`, `staleDays: 7`, `worklist`,
and `unmatchedIssues`. Each stale, undated, or issue-bearing source has its
own item in source order: `id`, `title`, `checkedAt` (date or null), `stale`
(boolean or null), original accepted citation `urls`, and `issueCodes` from
the reader. The reader associates issues by ID, so all issue codes for a
duplicate ID appear on each of its items; citations remain attached to their
original source. Issues without a parsed source appear in `unmatchedIssues`.
A fresh source with no issues is omitted. Empty worklists are successful.

Exit code 0 means success or help, 2 means invalid arguments, and 1 means the
file could not be safely read or the clock was invalid. Errors go to stderr,
with no JSON on stdout. This is data for review, not a READY job or executable
command. No research has been fetched; source text and links are untrusted and
are neither executed nor fetched by this tool.
