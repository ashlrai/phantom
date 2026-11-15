# pass^k offline eval suite

RQ-SWE5-PASSK-EVAL (research digest item 4). `phm eval passk` runs the pinned
golden task set N times per lane/model — every trial in a clean materialized
or copied worktree — and reports per-task and per-lane `pass@1` (Wilson 95%
interval), `pass@k` (the unbiased `1 - C(n-c,k)/C(n,k)` estimator) and
`pass^k` (`(c/n)^k`, all-k-succeed consistency). It builds on the
EVALHARNESS-1 single-shot golden-task scoring (tests / diffQuality /
instructions dimensions) and measures reliability, not just one-shot skill.

```sh
phm eval passk [--dataset <golden.jsonl>] [--repo-base <dir>]
               [--lane <lane:engine>]... [--trials N] [--k K]
               [--limit N] [--json] [--write <file>] [--baseline <file>]
               [--gate]
phm eval passk scores [--json]
phm eval passk alerts [--json]
phm eval passk schedule [--install] [--hour 0-23]
```

`--lane` names a `<lane>:<engine>` pair (e.g. `local:local-coder`); the
default is the loopback-only local lane, which skips cleanly when no local
provider is up. `--trials` (default 8, max 64) sets N per task; `--k`
(default 4, clamped to `trials`) sets the consistency window. `--gate`
exits 3 when the run regressed against the baseline, for CI wiring.

## Dataset

`benchmarks/passk/golden-tasks.jsonl` is an `eval.passk.v1` JSONL dataset: an
optional `{"v":1,"kind":"meta"}` line, then one task per line. A task carries
its snapshot inline (`files`: relative path → contents, materialized fresh
per trial) or as a staged `repoPath` (absolute, or relative under
`--repo-base`; copied per trial), a `goldTestCommand` from the safe
test-runner allowlist, optional `failToPassTests`, and the EVALHARNESS-1
output contract (`required`, `forbidden`, `maxChangedLines`). Malformed
lines, duplicate ids, unsafe snapshot paths, unsafe test commands and both
snapshot kinds at once are rejected with a line number — never silently run.
The report pins the dataset sha256, so a dataset edit shows up in every
subsequent report.

## Published artifacts

Each run persists under `~/.ashlr/eval/passk/` (`ASHLR_HOME` honored):

- `reports/<id>.json` — the full `eval.passk.v1` report, with per-trial
  detail.
- `latest.json` — atomic pointer to the newest report; the next run's
  regression baseline unless `--baseline` overrides it.
- `lane-scores.json` — the `eval.lane-scores.v1` projection
  `ashlr router rank` surfaces as advisory evidence per pool.
- `alerts.jsonl` — bounded (500-line) regression journal appended on
  publish.

`scores` prints the projection; `alerts` prints the journal. Both report
missing/degraded state and never throw.

## Regression alerts

Publish-time comparison against the prior report emits three alert kinds
(minimum drop 0.10): `task-regressed` (a task that previously passed at
least once now has zero passes), `passk-drop` (a lane's mean pass^k fell),
and `dimension-drop` (a lane/task tests/diffQuality/instructions rate fell).
Only (lane, model, task) triples present in both reports compare; a new
lane or dropped task is reported, never scored.

## Nightly schedule

`phm eval passk schedule` prints the per-user timer units;
`--install` writes and activates them through the shared
`dailyUserSchedule` machinery (launchd `ai.ashlr.phm.eval-passk` on macOS,
`phm-eval-passk.service` + `.timer` under `~/.config/systemd/user` on
Linux) at 03:58 local. The job runs `phm eval passk --json` against the
bundled golden set; logs land at `~/.ashlr/logs/eval-passk.jsonl`. Nothing
runs as root and no flags reach gated resources.

## Honesty rules

- A trial that errored, produced no patch, failed to apply or failed the
  gold test counts as a failed trial — never estimated or credited.
- `pass@1` = passing trials ÷ trials; `diffQuality` and `instructions` are
  dimension rates, not pass criteria.
- Lane scores are advisory evidence for routing surfaces; nothing here
  reserves capacity, dispatches or releases merge credit.
