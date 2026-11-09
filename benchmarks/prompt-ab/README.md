# Prompt A/B benchmark

RQ-SELFOPT-PROMPT-OPT: a frozen prompt-variant A/B day plus the promotion
record it produces — the "one promoted variant with before/after numbers" the
task requires, kept honest by the same counterfactual rules as the router-eval
harness.

`jobs.jsonl` freezes a day of router lines (router-eval.v1) in which the
candidates are prompt-variant arms (`prompt:plain`, `prompt:adaptive`) rather
than seat pools. `experiment.json` declares three job classes — `docs`,
`tests`, `secrets` — each with `prompt:plain` as control and `prompt:adaptive`
as challenger. `phm eval prompts` replays both arms per class through the
router-eval harness and applies the promotion gate:

```sh
npm run dev -- eval prompts --dataset benchmarks/prompt-ab/jobs.jsonl \
  --spec benchmarks/prompt-ab/experiment.json
npm run dev -- eval prompts --dataset benchmarks/prompt-ab/jobs.jsonl \
  --spec benchmarks/prompt-ab/experiment.json --promote
npm run dev -- eval prompts --dataset benchmarks/prompt-ab/jobs.jsonl \
  --spec benchmarks/prompt-ab/experiment.json \
  --check benchmarks/prompt-ab/promotions.json
```

The committed outcome, in `promotions.json` and `report.md`:

| Job class | Verdict | Before (`prompt:plain`) | After (`prompt:adaptive`) |
| --- | --- | --- | --- |
| `docs` | **promoted** | 33.3% merge (n=30) | 77.8% merge (n=27), +44.4 pts, disjoint 95% intervals |
| `tests` | held — not significant | 61.5% merge (n=26) | 66.7% merge (n=24), intervals overlap |
| `secrets` | held — insufficient data | 50.0% merge (n=6) | 50.0% merge (n=6), below the ≥8 resolved floor |

## The promotion gate

A challenger is promoted only when all of these hold (checked in this order,
first failure is the recorded verdict):

1. `thin-coverage` — unobserved decisions ≤ `maxUnobservedShare` (25%) of the
   cohort. Changed decisions without a frozen counterfactual are counted, never
   estimated — a promotion on thin coverage is refused.
2. `insufficient-data` — both arms resolve ≥ `minResolvedPerArm` (8) jobs.
3. `no-lift` — the challenger's merge rate beats the control's point estimate.
4. `not-significant` — the challenger's Wilson 95% lower bound clears the
   control's Wilson 95% upper bound (disjoint intervals).
5. `cost-regression` — cost per merged PR does not regress beyond
   `costRegressionTolerance` (50%).

`--promote` merges the verdicts into the prompt-promotions registry at
`~/.ashlr/eval/prompts/promotions.json` — the file `phm pulse` renders as the
"Prompt variants" dashboard section and `assignPromptVariant` reads to route
new jobs in a promoted class to the winning prompt.

## This is a synthetic record

Like `benchmarks/router-eval/`, `jobs.jsonl` is invented counterfactual ground
truth, not production telemetry: the adaptive variant wins the docs class by
construction so the promotion path, its numbers and the dashboard can be
verified end to end. `generate.mjs` emits the file deterministically —
`node benchmarks/prompt-ab/generate.mjs > benchmarks/prompt-ab/jobs.jsonl`
reproduces it byte for byte; the class comments name the intended merge
patterns. Regenerating `promotions.json` is only correct when a change is
*meant* to move the frozen-day verdicts — say so in the PR.
