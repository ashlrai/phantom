# Compare proposed and previous harness bets

From the repository root, score the overlap between proposed and previous
records in a local snapshot file using a Jaccard ratio of normalised tokens:

```sh
npx tsx examples/agents/harness-bet-overlap.ts --file snapshot.json
```

`--file` is required and specifies the path to a JSON file containing a
`proposed` array (up to 100 records) and a `previous` array (up to 2000
records), each element an object with unique non-blank `id` and non-blank
`text` string fields.

The single JSON object on stdout has `v` (always 1), `kind` (`"lexical_observations"`),
and an `observations` array.  Each observation contains `proposedId` and
a `prior` object (with `priorId`, `exact` boolean, `score` as the Jaccard
ratio) — or `prior` is `null` when the previous array is empty.  Exit
codes: `0` ok, `2` invalid arguments, `1` unreadable or malformed snapshot.
