# Outcome-driven router weight proposals

`phm router tune [--root <runs-dir>] [--min-sample <n>] [--max-shift <0<f<=1>] [--apply] [--json]` reads local files and prints a `router.tune.report.v1` JSON document with `--json`, or a tab-separated weight list plus a one-line cohort summary without it. It makes no network requests and changes no routing state.

## Evidence

The command folds two existing local journals under `<runs-dir>/metrics/` (default `ASHLR_RUNS_DIR`, then `~/.ashlr-runs`):

- `jobs.jsonl` through the same bounded `router.outcome.v1` fold as `phm route outcomes`: one outcome per job with `lane`, `work_class`, `merged`, `ci_first_pass`, `cost_usd`, `wall_s` and review-finding counts, all nullable. Malformed, unattached and ambiguous rows are counted in `inputs.outcomes`, never guessed.
- `work-market.jsonl` `work-market.v1` `route_decision` rows, joined by job ID. The latest decision supplies `work_class` (declared or derived by the market) and `chosen_lane`. An outcome's own recorded `lane`/`work_class` wins; the decision only fills gaps. A lane that cannot be attributed from either source is counted in `unattributed_outcomes` and excluded, never pooled as zero.

A missing or unreadable ledger reports its state (`missing`, `unreadable`, `not-file`, `too-large`) and yields no outcomes; unknown evidence stays `null`, never `0`.

## Cohorts and weights

Outcomes group into `(work_class, lane)` cohorts; `work_class: null` is the unclassified pool. Per cohort the report carries `attempts`, `resolved` (outcomes whose merge state is recorded — the evidence basis), `merged`, `pending`, `merge_rate`, the work-class `pool_resolved`/`pool_merge_rate`, `ci_first_pass_rate`, `cost_per_merged_usd` (mean recorded cost over merged outcomes with a known cost) and `mean_wall_s`; every unmeasured figure is `null`.

A cohort earns a `router.weights.v1` proposal only when `resolved >= --min-sample` (default 5) and its work-class pool merge rate is measurable and nonzero. The weight is the cohort merge rate divided by the pool merge rate, clamped to `1 ± --max-shift` (default 0.1) and rounded to 6 decimals; `1.0` means at pool rate. Refused cohorts keep their evidence counts under `status` (`insufficient-evidence`, `zero-pool-merge-rate`) with `weight: null`. v1 weights reflect merge rate only; CI, cost and wall evidence is reported for review but not folded in.

## Applying proposals

Dry run is the default and writes nothing. `--apply` appends each proposed `router.weights.v1` row (`work_class`, `lane`, `weight`, `evidence_n`, `updated_at`) to `metrics/router-weights.jsonl` (mode 0600), skipping rows identical to a previously recorded proposal for the same cohort evidence. The journal is a proposal ledger: no router, bandit, queue or spend path reads it, and activation is a separate reviewed change.

Exit codes: `0` report produced (including empty or fully refused cohorts), `1` unexpected read failure, `2` usage error.

See also [typed routing decisions](../ROUTING.md), [router calibration](calibration.md), and the shared-queue market contract in [docs/QUEUE.md](../QUEUE.md).
