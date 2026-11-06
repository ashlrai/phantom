# RADAR-MODELCAPS offline fixtures

These checked-in JSON snapshots are synthetic, sanitized examples of the
OpenAI-compatible `/v1/models` list shape, not authenticated provider captures.
No live request was made to produce them. IDs and owner names are fictional.
The optional `capabilities` array exercises provider extensions; its absence
means unknown, while an empty array means explicitly reported empty.

Compare saved responses from the same provider, endpoint and account scope:

```sh
npx tsx scripts/radar-modelcaps.ts test/fixtures/radar-modelcaps/before.json test/fixtures/radar-modelcaps/after.json
```

The command reads local files only and prints deterministic new-model,
removed-model and capability-change observations. Capture all pages before
comparison. Partial lists, invalid entries and duplicate IDs fail closed.
A removal can reflect account visibility changes, not provider retirement.
This report does not modify routing defaults or verify capability claims.
Never store authorization headers, account identifiers or credentials in fixtures.
