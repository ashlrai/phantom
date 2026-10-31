# Queue rejection trace

From the repository root:

```sh
npx tsx examples/agents/queue-rejection-trace.ts --job RQ-EXAMPLE
npx tsx examples/agents/queue-rejection-trace.ts --job RQ-EXAMPLE --limit 25 --wait-ms 10000
```

This read-only workflow correlates the fleet queue's precheck skips with the
leader journal's ingest rejections. `--job` is a case-sensitive ID of at most
80 letters, digits, dots, underscores or hyphens, starting with a letter or
digit. A precheck matches the exact ID. An ingest record matches only the exact ID
or its exact `.md` filename, compared against the file basename. Prefix-similar IDs do not match.

One JSON object is printed to stdout. `sources` reports `precheck` and `ingest`
health independently (`healthy`, `missing`, or `degraded`). `timeline` contains
`source`, `at`, `code`, and `reason` for each match. Prechecks are newest first;
ingest rejections follow in newest-first log order. The journal reader does not
expose ingest timestamps, even for timestamped log lines, so their `at` is
always null. An invalid precheck timestamp is also null. Untimed entries have
no known ordering relative to timed entries. `latest` retains the newest entry
from each source even when the timeline is capped; it does not infer which
source is globally latest. `truncated` indicates that the output limit omitted
matching entries from the available projections.

`--limit` defaults to 50 and accepts 1–100. `--wait-ms` defaults to 0 and accepts
0–30000; when both sources are healthy and no match exists, it checks again at
up to one-second intervals until a match, source failure, interruption, or the
finite wait expires. A healthy empty result does not prove that a job launched:
the underlying readers inspect bounded tails and expose at most 200 skips and
30 ingest rows, potentially including other jobs. They may omit older matches;
`truncated` only describes the output cap, not reader truncation.

Exit 0 means both relevant sources are healthy, even with no matches; exit 1
means a source is unavailable or degraded (the other source is still reported),
or an unexpected failure; exit 2 means invalid arguments; exit 130 means
interrupted. Errors are JSON and do not expose reader exceptions. The command
uses the existing readers' path validation and scrubbing and never executes log
content or changes queue or inbox files.

Exit code 0 means both relevant sources are healthy, including when no match
was found; 1 means a source is unavailable or an unexpected failure occurred;
2 means invalid arguments; and 130 means the workflow was interrupted. A
source failure still returns the other source’s available entries. The readers
scan bounded tails and expose at most 200 prechecks and 30 ingest rows before
filtering, so an empty trace does not prove that no older rejection exists.
