# Merge queue latency

Record observed transitions in a local JSONL ledger, then read the report:

```sh
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"queued","at":"2026-11-01T12:00:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"blocked","at":"2026-11-01T12:01:00Z","reason":"required_checks"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"eligible","at":"2026-11-01T12:05:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --record '{"repo":"ashlrai/phantom","pr":123,"type":"merged","at":"2026-11-01T12:06:00Z"}'
phm fleet merge-latency --events merge-events.jsonl --json
```

Use actual observed timestamps. Eligible means the observer saw the PR satisfy its merge requirements; this command does not determine eligibility. Blocker reasons are `required_checks`, `review`, `conflict`, `queue`, or `other`. The report retains blocker timestamps and gives enqueue-to-eligibility and eligibility-to-merge durations only when each boundary is unique, ordered, and no blocker was recorded after eligibility. Missing or ambiguous evidence stays unknown. The ledger is not populated automatically, and recording an observation never changes the queue or bypasses required checks. The JSON report is the agent interface; omit `--json` for plain words.
