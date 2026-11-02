# Router eval report

- Dataset: router-eval-2026-10-26 (2026-10-26) — 45 frozen router lines, sha256 `92e52795c84c`
- Policy: `logged` — bootstrap 2000 resamples, seed 6168327

## Headline (95% CI)

| Metric | Value |
| --- | --- |
| Merge rate | 69.0% [54.0% – 80.9%] (n=42) |
| Cost per merged PR | $2.55 [$1.81 – $3.56] (n=42) |
| Tokens per merged PR | 152k [113k – 204k] (n=42) |
| Wall time (mean) | 51m [42m – 61m] (n=42) |

## Coverage

resolved=42 observed=42 unobserved=0 held=2 pending=1 changed=0 rejected=0 of 45 jobs.

## Per-arm

| Arm | Decided | Observed | Merged | Resolved | Merge rate | Cost USD | Tokens | Mean wall |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| codex-cmp | 19 | 18 | 12 | 18 | 66.7% | $14.96 | 1.0M | 25m |
| codex-personal | 3 | 3 | 3 | 3 | 100.0% | $2.03 | 129k | 19m |
| devin | 15 | 15 | 9 | 15 | 60.0% | $55.10 | 3.0M | 82m |
| local-qwen | 4 | 4 | 3 | 4 | 75.0% | $0.00 | 198k | 94m |
| prompt:adaptive | 2 | 2 | 2 | 2 | 100.0% | $1.79 | 123k | 26m |

Merge-rate intervals are Wilson score intervals; cost/token-per-merge and wall-time intervals are seeded percentile bootstrap. Changed decisions without a frozen counterfactual are unobserved — never estimated. Intervals describe sampling noise over the frozen set, not counterfactual certainty.
