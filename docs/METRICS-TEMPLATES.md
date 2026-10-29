# Router template metrics

`phm metrics templates --json` prints a single JSON report to stdout and writes
no files. The router feed is currently a local adapter stub: the default report
explicitly says `source: "unavailable"`, rather than pretending zero jobs were
observed. No workspace paths, credentials or network access are required.

Until RQ-METRICS-ROUTER-FEED is integrated, pipe a snapshot into
`phm metrics templates --stdin --json`. Snapshot contract:

```json
{
  "schemaVersion": 1,
  "available": true,
  "jobs": [
    {
      "jobId": "RQ-PLAN-EXAMPLE",
      "outcome": "merged",
      "tokens": 12000,
      "impact": { "score": 4, "version": "shared-scorer-version" }
    }
  ]
}
```

Each unique job appears once with its latest outcome: `merged`, `empty`,
`incomplete`, `failed` or `pending`. Duplicate IDs and invalid observations fail
closed with exit 2 and a sanitized stdout error. The adapter owns reconciliation
and merge evidence; this report does not infer a merge from a PR being opened.
Stdin snapshots are limited to 16 MiB.

Families use two prefix segments for RQ and LAND, and one otherwise:
RQ-PLAN-*, RQ-FIXUP-*, LAND-RECUT-*, RADAR-* and RQ-PL-* remain distinct.
Pending jobs are displayed but excluded from all completed-job denominators.
Rates are fractions; no completed observations means null, not zero.
Five completed jobs are required for rankings and recommendations. Empty rate
strictly above 0.30 flags `retire-or-rewrite`; combined empty and incomplete rate
above 0.30 flags `rewrite`. These are advisory flags and never retire anything.
The quality ranking lists the highest empty or incomplete rates first.

The primary productivity ranking is merged impact per million tokens, using
shared impact-score receipts from RQ-METRICS-IMPACT-SCORE, without estimating
local weights. Tokens include all completed work, including failures and empty
results. Missing token observations, missing merged-job receipts, mixed receipt
versions or zero total tokens withhold that template's impact ranking. Raw merge
rate remains a separate diagnostic. A receipt score of zero is an observation;
a missing receipt is unknown. Rank comparisons require one shared score version
across eligible templates. Neither shared dependency exists in this checkout;
replace `readRouterFeed` with the real feed when available, preserving this
snapshot contract or adding an explicit adapter.
