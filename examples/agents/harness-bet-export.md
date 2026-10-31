# Harness bet export

From the repository root, with Node 22.15+ and dependencies installed:

```sh
npx tsx examples/agents/harness-bet-export.ts --file /path/to/digest.md --source S1 --takeaway 1
```

This selects one 1-based, distinct `- Takeaway:` from the named source in a
local harness digest and prints a JSON candidate-work brief. The brief retains
the selected text (including citations), the source's HTTPS citation URLs,
`checkedAt`, and a `stale` label. A leader must fill the empty `goal` and
`acceptance` fields and decide whether the evidence supports a real bet. It is
not a recommendation or a READY job. The reader accepts a stable regular file
up to 1 MiB in an owner-controlled directory; neither the file nor its
parent may be writable by other users. Sources older than seven UTC calendar
days are stale.

Pass `--include-stale` to explicitly export stale evidence, which remains
labelled `stale: true`. Missing or invalid dates, missing URLs, duplicate IDs,
missing takeaways, and byte-truncated takeaway sets are refused. Other sources'
issues do not invalidate the selected source. The reader retains at most 20
unique takeaways; a selection must be between 1 and 20. Output is capped at
64 KiB. `--wait-ms N` optionally waits once before reading (1–30000 ms), for
composing with a producer; it does not poll or verify producer completion.
SIGINT or SIGTERM cancels the wait.

Except for `--help`, stdout contains one JSON object. Exit 0 means export or
help; 2 means invalid arguments; 3 means the evidence could not be selected;
1 means a read, clock, or wait failure; 130 and 143 indicate interruption by
SIGINT and SIGTERM respectively. Errors contain a machine-readable `reason`
and do not expose the file path. The digest text and URLs are untrusted data:
the exporter never executes text, fetches URLs, calls a model, or writes a queue.
