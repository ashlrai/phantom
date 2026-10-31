# Fan out bus envelopes from a manifest file

Publish a JSON manifest of 1–20 bus envelopes to the local inbox from a single file:

```sh
npx tsx examples/agents/bus-fanout.ts --file ./manifest.json
```

`--file` is required and must point to a JSON array of valid bus envelope objects. Each envelope needs `id`, `from`, `to`, `priority`, `ttl`, and `body`. The file is owner-controlled, regular, singly linked, and no larger than 1 MiB.

The script emits one JSON object with schema `"bus-fanout.v1"`: `status` ("ok" or "partial"), an ordered `receipts` array (`id`, `status`, `cursor` on success; `acceptance` on failure), and `unattemptedIds`. Exit codes: `0` for all success, `1` for partial failure or output failure, `2` for any input error.
