# Export latest inbox instructions as JSON

From the repository root, read the newest inbox entries and emit one JSON
prompt input filtered by channel label and count:

```sh
npx tsx examples/agents/inbox-prompt-export.ts --source Telegram --limit 50
```

`--source` is optional: selects one attributed channel label (case-insensitive).
`--limit` defaults to 20 (integer 1–200).

The single JSON object on stdout has `v` (always 1), `generatedAt` (ISO),
`sourceHealth` (`"healthy"`, `"missing"`, or `"degraded"`), `source` (label
or `null`), `limit`, `dropped` (rejected tail rows), and `instructions` (an
array of `{source, at, priority, text}`).  Exit codes: `0` ok (including
missing inbox), `2` invalid arguments, `1` read failed (a degraded inbox
still emits the payload and exits 1).
