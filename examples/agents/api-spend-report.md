# API spend report

From the repository root, run:

```sh
npx tsx examples/agents/api-spend-report.ts
npx tsx examples/agents/api-spend-report.ts --sort usd --limit 10
```

The report reads the existing local resource ledger; it does not call a provider. It reports the current local day's model usage in the ledger's bounded API spend tail. `--sort` accepts `tokens` (the default, input plus output), `errors`, or `usd`; values descend and ties use ascending model name. Unknown USD values sort after known values. `--limit` is an optional integer from 1 to 100; without it all model groups returned by the ledger are shown.

Standard output is a JSON object with `source` (the path relative to the runs directory), `sourceHealth`, `observedAt` (ledger generation time), `lastAt` (latest valid spend observation, or null), `sort`, and `rows`. Each row contains `model`, `rows`, `errors`, `inputTokens`, `outputTokens`, `usd`, and `lastAt`. USD is null when no cost was observed for that model; a numeric value sums observed costs and does not imply every event had a cost. `omittedModels` counts model groups omitted by the ledger's 100-model cap and by `--limit`. `unrepresentedRows` counts today's source events not represented in displayed groups, including events with invalid or missing model names; it is null if the source could not be read.

The ledger selects up to 100 model groups alphabetically before this report sorts them, so a high-usage omitted model cannot be recovered by changing the sort. Its bounded tail can also exclude older file entries. Source health is `healthy`, `missing`, or `degraded`; degraded data may be partial.

Exit codes: 0 for a healthy source, 1 for a missing/degraded source or a ledger read failure, and 2 for invalid arguments. Missing and degraded sources still produce JSON; an unexpected read failure prints a generic error to stderr instead. Invalid arguments print usage to stderr.
