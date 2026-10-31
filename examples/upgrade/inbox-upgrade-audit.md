# Inbox upgrade audit

From a Phantom source checkout with its dependencies already available, run:

```sh
npx tsx examples/upgrade/inbox-upgrade-audit.ts --limit 200 --all-sources
npx tsx examples/upgrade/inbox-upgrade-audit.ts --limit 200 --source Telegram
```

Choose a limit from 1 to 200 and explicitly select all sources or one source label. The source match
is case-insensitive. The reader takes the newest `limit` entries **before** the
source filter, just like the HTTP route; it reads at most the last 256 KiB. The
projection returns the selected window oldest first, retaining file order for
equal timestamps. A filtered result may therefore contain fewer than `limit`
entries even when older entries from that source exist.

The version 1 JSON reports health, counts, fixed source buckets, and whether the
selection, health, and ordered entries agree. It compares timestamps, source,
priority and full text in memory, but prints no entries, bodies, arbitrary source
labels, timestamps, hashes, paths or exception details. Projection redaction or
rejection is reported as a mismatch. `unknown` counts unrecognized headings;
`other` groups all other labels. The audit calls the same reader and projection
as the HTTP route, locally, without contacting a running app or changing data.

Run with the same selection before and after an upgrade and retain the reports
in a suitable private location. Matching reports show only that the aggregate
counts and current projection checks agree; they cannot prove that individual
entries survived across runs. A verified result checks only the selected bounded
window, not older history, delivery, deduplication, a separately running server,
or the installed binary's version. To establish continuity of a particular
entry, use an independently retained, privacy-appropriate source of evidence.

Exit codes: **0** verified with at least one selected entry and a healthy source;
**1** mismatch or read/projection failure; **2** invalid usage; **3** missing or
degraded source, or no selected entries (unless a mismatch is also detected,
which takes precedence). `--help` does not read the inbox.
