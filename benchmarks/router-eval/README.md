# Router eval benchmark

RQ-SELFOPT-EVAL-HARNESS: an offline eval harness and regression benchmark for
router and prompt policies.

`jobs.jsonl` freezes a day of router lines (router-eval.v1) with known
outcomes. `phm eval router` replays any policy against them and reports merge
rate, cost per merged PR and wall time with confidence intervals:

```sh
npm run dev -- eval router --dataset benchmarks/router-eval/jobs.jsonl --policy logged
npm run dev -- eval router --dataset benchmarks/router-eval/jobs.jsonl --policy cheapest --json
npm run dev -- eval router --dataset benchmarks/router-eval/jobs.jsonl --policy list
```

The regression benchmark is `test/router-eval-harness.test.ts`: it reruns the
`logged` policy and requires the committed `baseline.json` to reproduce
exactly, then replays challenger policies and pins the counterfactual /
unobserved splits. It is an ordinary vitest suite, so it runs in the daily
master run (`ci.yml` schedule → `npm run test:ci`) with everything else.

## Honesty rules (same stance as the seat-router replay)

- A replayed decision that matches the recorded arm uses the recorded
  outcome. A changed decision uses the line's frozen `arms` counterfactual
  table when one covers the arm, and is *unobserved* otherwise — the harness
  never estimates, interpolates or credits a counterfactual outcome it was
  not given.
- Lines that carry `arms` tables are frozen benchmark ground truth for that
  line only; lines without them model real history, where only the realized
  arm's outcome is known.
- Policies see only router-time fields (id, at, repo, pool, tier, priority,
  task, candidates, and the meta arm catalog). Recorded outcome, cost and
  wall-time columns are stripped from the decision view.
- `held` lines were never dispatched (`chosen: null`); `pending` lines were
  dispatched but unresolved at freeze time. Neither enters the terminal
  cohort.
- Confidence intervals describe sampling noise over the frozen set (Wilson
  for the merge-rate proportion, seeded percentile bootstrap for per-merge
  ratios and wall time), not counterfactual certainty. The seed and resample
  count are pinned in the report so the baseline reproduces byte for byte.

## This is a synthetic record

Like `test/fixtures/router-replay/`, this is a checked-in regression
recording, not production telemetry or evidence of real PR throughput. The
`arms` tables are invented ground truth that exists so policy changes can be
scored; projecting a sanitized live capture into router-eval.v1 is the
documented way to evaluate against real history (populate `candidates`,
`chosen`, `outcome` and the measured `costUsd` / `tokens` / `wallTimeMs`
columns, and leave `arms` absent where no counterfactual is known).

## Regenerating the baseline

Only regenerate when a change is *meant* to move the frozen-day metrics, and
say so in the PR:

```sh
npm run dev -- eval router --dataset benchmarks/router-eval/jobs.jsonl \
  --policy logged --decisions \
  --write benchmarks/router-eval/baseline.json \
  > benchmarks/router-eval/baseline.md
```

`--check benchmarks/router-eval/baseline.json` compares a replay to the
baseline and exits 1 on drift; the test suite uses it as the daily gate.
