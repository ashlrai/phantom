# Prompt A/B report

- Experiment: prompt-ab-2026-10-28 — dataset prompt-ab-2026-10-28 (65 frozen lines, sha256 `de1488606aba`)
- Gate: ≥8 resolved per arm, ≤25.0% unobserved, disjoint Wilson 95% intervals, cost-per-merge regression ≤50.0%

## docs — promoted `prompt:adaptive`

| Arm | Resolved | Merged | Merge rate | Cost/merge | Wall mean |
| --- | ---: | ---: | --- | --- | --- |
| prompt:plain (control) | 30 | 10 | 33.3% [19.2% – 51.2%] | $1.72 [$1.13 – $3.38] | 25m [24m – 26m] |
| prompt:adaptive | 27 | 21 | 77.8% [59.2% – 89.4%] | $1.11 [$0.94 – $1.45] | 29m [28m – 30m] |

- prompt:adaptive: **PROMOTED** (+44.4 pts vs control)

## tests — no promotion

| Arm | Resolved | Merged | Merge rate | Cost/merge | Wall mean |
| --- | ---: | ---: | --- | --- | --- |
| prompt:plain (control) | 26 | 16 | 61.5% [42.5% – 77.6%] | $0.93 [$0.70 – $1.35] | 25m [23m – 26m] |
| prompt:adaptive | 24 | 16 | 66.7% [46.7% – 82.0%] | $1.30 [$1.01 – $1.89] | 29m [27m – 30m] |

- prompt:adaptive: **held — not significant** (+5.1 pts vs control)

## secrets — no promotion

| Arm | Resolved | Merged | Merge rate | Cost/merge | Wall mean |
| --- | ---: | ---: | --- | --- | --- |
| prompt:plain (control) | 6 | 3 | 50.0% [18.8% – 81.2%] | $1.12 [$0.61 – $3.55] | 25m [22m – 28m] |
| prompt:adaptive | 6 | 3 | 50.0% [18.8% – 81.2%] | $1.72 [$1.01 – $5.15] | 29m [26m – 32m] |

- prompt:adaptive: **held — insufficient data** (+0.0 pts vs control)

## Promotions

| Job class | Variant | Before | After | Lift |
| --- | --- | --- | --- | --- |
| docs | prompt:adaptive | 33.3% (n=30) | 77.8% (n=27) | +44.4 pts |

Merge-rate intervals are Wilson score; cost/wall intervals are seeded bootstrap. Only counterfactually-covered decisions are observed — the gate refuses promotion on thin coverage.
