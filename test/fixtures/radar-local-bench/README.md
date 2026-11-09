# RADAR-LOCAL-BENCH fixtures

Synthetic, sanitized fixtures for the loopback-only local-model bench in
`src/core/radar/local-bench.ts` (`scripts/radar-local-bench.ts`). No live
capture, no credentials, no production telemetry: every case was written for
this bench, and the text exercises the vocabularies the real decision paths
use (`decide/triage.ts` work lanes, the `local`/`mid`/`frontier` trust tiers,
and `VerifyEvidence.failureCategory` for CI bucketing).

Each file is one suite:

```json
{ "schema": "ashlr.radar-local-bench.v1", "suite": "triage",
  "labels": ["…"], "instruction": "…",
  "cases": [{ "id": "…", "input": "…", "expected": "…",
              "tokensIn": 220, "tokensOut": 3 }] }
```

`expected` must be one of `labels`; the bench scores exact label matches —
a model never grades a model. `tokensIn`/`tokensOut` are estimates feeding
the dollars-saved math only when the endpoint reports no usage; measured
usage always wins. Add cases by appending to `cases`; keep ids unique within
a suite and keep text free of real PRs, paths outside this repo, names and
credentials.

Run the bench against a local serving runtime (loopback endpoints only —
anything else is refused before a request is made, and redirect replies are
refused rather than followed):

```sh
npx tsx scripts/radar-local-bench.ts \
  --models lfm3:1.7b,d1:2b --incumbent qwen3.8:27b-ctx64k \
  --out benchmarks/radar-local-bench-$(date -u +%Y%m%d).json
```

The results file records per-suite accuracy against the incumbent local tier
and the `devCycleDashboard` samples
(`phantom_cycle_local_model_dollars_saved_per_100_jobs`) for the
engineering-cycle dashboard — an estimate at the repo's would-be-cloud
reference price, accuracy-weighted, never a billing claim. Offline tests:

```sh
HOME=$(mktemp -d) npx vitest run test/radar-local-bench.test.ts test/radar-local-bench-redirect.test.ts
```
