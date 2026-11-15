# pass^k golden-task benchmark

RQ-SWE5-PASSK-EVAL (research digest item 4): the nightly offline eval suite
for lane/model reliability on a fixed set of real golden tasks.

`golden-tasks.jsonl` is an `eval.passk.v1` dataset: an optional
`{"v":1,"kind":"meta"}` line, then one task line each. A task carries its
snapshot inline (`files`: relative path → contents, materialized into a
fresh worktree per trial) or as a staged `repoPath` (absolute, copied per
trial), a `goldTestCommand` from the safe test-runner allowlist, optional
`failToPassTests`, and the EVALHARNESS-1 output contract (`required`,
`forbidden`, `maxChangedLines`). Duplicate ids, unsafe paths, both snapshot
kinds at once and unsafe test commands are rejected with a line number —
never silently run.

```sh
npm run dev -- eval passk                                  # bundled set, default local lane
npm run dev -- eval passk --trials 8 --k 4 --json
npm run dev -- eval passk --dataset benchmarks/passk/golden-tasks.jsonl --lane local:local-coder
npm run dev -- eval passk scores --json                    # the lane-routing projection
npm run dev -- eval passk alerts --json                    # the regression journal
npm run dev -- eval passk schedule                         # print the nightly timer units
```

`phm eval passk` runs every task `trials` times per lane/model, each trial
in a clean materialized/copied worktree, and reports per-task `pass1`
(Wilson CI), `pass@k` (the unbiased `1 - C(n-c,k)/C(n,k)` estimator) and
`pass^k` (`(c/n)^k`, all-k-succeed consistency). Runs persist under
`~/.ashlr/eval/passk/`: `reports/<id>.json`, an atomic `latest.json`, the
`lane-scores.json` projection (`eval.lane-scores.v1`) `ashlr router rank`
surfaces as advisory evidence, and a bounded `alerts.jsonl` regression
journal. `phm eval passk schedule --install` installs the nightly per-user
timer through the shared `dailyUserSchedule` machinery.

## Honesty rules

- A trial that errored, produced no patch or failed to apply counts as a
  failed trial — never estimated, interpolated or credited.
- Alerts compare only (lane, model, task) triples present in both the prior
  and current reports; a new lane or removed task is reported, not scored.
- `pass@1` = resolved gold-test trials ÷ trials. `diffQuality` and
  `instructions` are dimension rates, not pass criteria.
- Lane scores are advisory evidence for routing surfaces; nothing here
  reserves capacity, dispatches or releases merge credit.
- `--gate` exits 3 on a regression vs the baseline, for CI wiring.

## Editing the golden set

Keep tasks small and self-contained. Each `files` entry is bounded (64
files, 128 KB each, relative paths only) and `goldTestCommand` must match
the safe test-runner allowlist (`node`, `pytest`, `npm test`, `go test`,
`vitest`, `jest`, …). A task change moves the dataset sha256 — the nightly
report pins it, so a dataset edit is visible in every subsequent report.
