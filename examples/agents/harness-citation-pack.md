# Pack evidence bundle from a harness digest

From the repository root, build a JSON evidence bundle from a local harness
digest file, filtered by a query text and a byte budget:

```sh
npx tsx examples/agents/harness-citation-pack.ts --file digest.md --query "authentication bug" --byte-budget 2048
```

`--file` is required (path to a digest markdown file, max 4096 characters).
`--query` is required (non-blank task text). `--byte-budget` is required
(integer 256–16384, the maximum byte length of the serialised output).

The single JSON object on stdout has `v` (always 1), `evidence` (`"untrusted"`),
`records` (an array of `{id, checkedAt, urls, takeaway}`), `omittedCount` (number
of eligible records pruned to honour the budget), and `empty` (boolean).  Exit
codes: `0` ok, `2` invalid arguments, `1` unreadable source (reported as
`invalid_clock`, `digest_unreadable`, or `pack_failed`).
