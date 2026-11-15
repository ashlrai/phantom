# Routing learning and test-time compute

Research date: 2026-10-26. Baseline: `a6f3c323`. Job: RQ-RESEARCH-ROUTING-RL.
Status: offline research and evaluation utility; no runtime learning enabled.

## Decision

Start with evidence collection and a constrained contextual bandit in offline
replay. Evaluate adaptive compute allocation next. Defer a trained sequential RL
router until it beats a simple escalation policy on held-out engineering tasks.
Neither an accuracy reward nor a learned cost penalty can grant execution rights.

This change takes the READY follow-up option because all of `src/core/routing/`
is Tier-1 protected. It adds a pure offline evaluator and tests, changes no
routing defaults, uses no provider inference, creates no credentials and requires
no new dependencies. The final job instructions prohibit committing or publishing;
`publish.sh` and PR creation are therefore left to the authorized handoff.

## Verified primary sources, 2025 to 2026

Dates below are publication/submission dates, not search-engine crawl dates.
Paper results are evidence for experiment selection, not measured Phantom gains.

| Source | Date and version | Relevant finding and transfer limit |
| --- | --- | --- |
| [Panda et al., Adaptive LLM Routing under Budget Constraints](https://aclanthology.org/2025.findings-emnlp.1301/) | November 2025, Findings of EMNLP | PILOT uses preference-informed LinUCB with selected-model feedback and a multi-choice knapsack cost policy. This motivates learning from partial feedback. Its shared embeddings and model cost assumptions are not Phantom's account-window admission evidence. |
| [Zuo and Zhu, Strategic Scaling of Test-Time Compute: A Bandit Learning Approach](https://arxiv.org/abs/2506.12721v2) | First submitted 2025-06-15; revised 2026-04-23, v2 | Adaptive allocation estimates difficulty and prioritizes solvable difficult queries. Math and code results motivate comparing marginal gains per attempt against uniform allocation; they do not establish gains for repository patches or delayed test outcomes. |
| [Qian et al., xRouter: Training Cost-Aware LLMs Orchestration System via Reinforcement Learning](https://arxiv.org/abs/2510.08439v1) | 2025-10-09, v1 | A router learns whether to answer or call external models using cost-aware RL rewards. Useful for multi-step escalation, but training cost, orchestration failures and model drift must be included in Phantom's evaluation. |
| [Muennighoff et al., s1: Simple test-time scaling](https://arxiv.org/abs/2501.19393v3) | First submitted 2025-01-31; revised 2025-03-01, v3 | Budget forcing controls reasoning length in a fine-tuned model. It motivates treating compute as a decision variable. Appending “Wait” is not a generic control API for hosted coding agents and is not proposed here. |

## Current code and integration boundary

Read [router.ts](../../src/core/routing/router.ts),
[policy.ts](../../src/core/routing/policy.ts),
[headroom.ts](../../src/core/routing/headroom.ts) and
[reset-pressure.ts](../../src/core/routing/reset-pressure.ts) together.

- `routeVerdicts` applies account eligibility and context fit before `rank`.
  Autonomous scheduling evidence marked unknown excludes otherwise eligible
  seats. Claude API remains uncommissioned; Devin has separate lane rules.
- `rankEligibleCapacities` returns the original eligible capacity objects.
  A future action must identify account, exact model/version and compute setting,
  not just provider or display tier. Multiple models can share one account quota.
- `rank` uses explicitly requested tiers, admitted headroom and funding category.
  Unknown quality is neutral. Aggregate latency and inferred catalog tiers do
  not establish comparable task performance. `lambdaLatency` remains inactive.
- Scheduling can reorder within explicit preference groups using reset
  opportunity, advisory seat and reset time. An advisory seat is not an admission
  mechanism or a complete stochastic action distribution.
- `effectiveSeatPolicy` applies stored seat overrides or mode defaults.
  `applyModeSwitch` preserves enabled state and hard daily caps while rebasing
  reserves. The default mode is balanced, with Codex disabled by default.
  These are operator choices, never learner parameters.

Future integration: immutable admission snapshot -> existing eligible action set
-> learned suggestion within permitted preference/opportunity groups -> current
admission recheck at dispatch. An empty set means no launch. Stale policy,
unsupported model identity or missing evidence falls back to the existing rank.
No learner writes `policy.ts` settings, fabricates headroom, or lifts a cap.
Runtime integration requires a separate owner-lane review.

## Common experiment contract

All numerical targets below are proposed acceptance thresholds, not predictions
backed by a Phantom experiment. IMPACT-SCORE is a prioritization heuristic:
benefit (1 to 5) times confidence (0 to 1), divided by effort (1 to 5), rounded to
two decimals. Scores compare these proposals only.

Build a versioned corpus of engineering tasks with immutable repository revisions,
independent test/verifier versions and deduplicated task families. Split by repo
and time before tuning; keep related patches in the same split. Start with 500
held-out tasks, then increase sample size if uncertainty cannot resolve the
predeclared quality margin. Report 95% paired bootstrap intervals clustered by
repository/task family; correlated attempts are not independent tasks.

Primary outcome: independently verified task success. Secondary outcomes:
measured token use, authorized native quota units, observed dollars where known,
p50/p95 end-to-end latency, retries and verifier cost. Do not convert a subscription
funding category into invented per-call dollars. Report unknown costs separately.
Quality noninferiority margin: at most 1 percentage point below baseline, with the
lower 95% confidence bound on the paired difference above -0.01. Every candidate
must have zero admission violations; aggregate utility cannot compensate for one.

For each decision, record a pseudonymous task ID, repo revision, task features
available before execution, account/model/version, eligible action IDs, full
behavior probabilities after filtering, selected action, policy version, admission
snapshot hash, timestamp and compute cap. Join immutable outcomes with a decision
ID. Record pending, timeout, cancellation and infrastructure error separately;
pending is not failure. Freeze an outcome horizon and publish censoring rates.
Do not log raw prompts, credentials or chain-of-thought. Existing deterministic
routing has zero probability for alternatives; its history alone cannot identify
the value of a new policy. Do not invent propensities after the fact.

## Idea 1: constrained contextual bandit for model choice

**IMPACT-SCORE: 1.00** (benefit 4, confidence 0.75, effort 3).
Expected impact target: 10% fewer measured inference tokens per verified success
at the common quality margin, with p95 latency no more than 5% worse.
Source: PILOT, November 2025, above.

Use task class, difficulty, context size and measured account/model-specific
features. Compare a linear contextual bandit with the current deterministic rank
and a simple fixed cheapest-qualified baseline. Start without learned embeddings:
this isolates the benefit of feedback from the cost of a feature model. Mask
ineligible actions before computing probabilities. Cold-start arms get no assumed
quality bonus. A model update invalidates its old calibration until revalidated.

Experiment: on a previously authorized, fully evaluated offline corpus, replay
seeded choices with selected-action feedback only, hiding other outcomes from the
learner. Tune on training tasks; freeze the target policy for held-out replay.
Ablate context features and a sliding training window to test drift sensitivity.
Include account-quota depletion and model replacement scenarios. Compare against
an oracle only as an upper bound, never as a deployable policy.

Where actual randomized logs exist, estimate IPS and self-normalized IPS (SNIPS)
with logged probabilities. Require effective sample size at least 200 overall
and 50 per reported task stratum, plus confidence intervals that pass the common
gate. These sample floors do not themselves establish adequate statistical power.
No overlap or insufficient support means “unidentified”, not a failed model.
Next deliverable: offline evidence schema and replay report, not live exploration.

## Idea 2: allocate compute by marginal verified gain

**IMPACT-SCORE: 1.17** (benefit 5, confidence 0.70, effort 3).
Expected impact target: 15% fewer total inference tokens at the common quality
margin, or a positive lower confidence bound on success gain at equal compute.
Sources: Strategic Scaling v2 (2026-04-23) and s1 v3 (2025-03-01), above.

Separate two actions: which eligible model to use, and how much compute to spend.
Evaluate bounded supported effort settings or maximum additional attempts, not
unbounded reasoning. Stop on independent verified success, exhausted task budget,
expired admission, deadline or lack of calibrated expected marginal improvement.
Verification itself consumes time and compute and belongs in the budget.

Experiment: use existing authorized traces with attempt-level outcomes and cost,
including unsolved tasks. Compare fixed one-attempt, uniform two-attempt and
adaptive stop/continue under the same total batch budget and per-task maximum of
three attempts. At each decision expose only previous attempts, never future
verification. Include checker false positives, delayed results, easy tasks and
persistently unsolvable tasks. A fixed batch budget must not starve older tasks;
report completion and latency by difficulty and age. Distinguish generated
candidate success (pass@k) from success of the candidate actually selected.

Any winner must satisfy the common gate and reduce wasted attempts on unsolved
tasks without reducing their first-attempt coverage. Offline trace truncation can
compare stopping rules, but cannot establish the value of a new reasoning setting
absent from the traces. Such settings remain unevaluated. Later runtime work would
involve the protected best-of-n policy as well as routing and needs owner review.

## Idea 3: sequential RL for escalation, only after simpler baselines

**IMPACT-SCORE: 0.40** (benefit 4, confidence 0.50, effort 5).
Expected impact target: 5 percentage points more verified successes than fixed
escalation at equal total compute, including router and verifier overhead.
Source: xRouter v1 (2025-10-09), above.

Represent a task as a short trajectory: choose an eligible worker, inspect an
independent result, stop or escalate. The state includes remaining authorized
compute and observed verification status. Reward verified success, penalize
measured resource use, and enforce rights and budgets outside the reward. Keep
hard turn limits. A positive reward never authorizes an external tool or payment.

Experiment: first compare a frozen RL policy against contextual bandit plus
fixed escalation on the same held-out trajectories. Train only on training repos;
include training and orchestration cost in amortization at 100, 1,000 and 10,000
tasks. Ablate cost penalties, state history and learned stopping. Stress tool
failure and model drift. Reject if it only beats a weak single-model baseline,
if savings disappear after overhead, or if any admission constraint is violated.
Single-decision IPS is insufficient for this sequential experiment: use a
validated trajectory estimator with sequential support or a fully specified
simulator, followed by an independently authorized controlled evaluation.

## Executable offline diagnostic

[scripts/evaluators/routing-off-policy.mjs](../../scripts/evaluators/routing-off-policy.mjs)
exports `evaluateRoutingPolicy(rows)`. Each row contains `action`, observed
`reward` in [0, 1], and `behavior`/`target` probability maps over the same eligible
action set. The caller is responsible for trustworthy provenance and admission;
the utility does not claim to authenticate either. No files, network, model
calls or production imports are used.

For row i, w_i = target(action_i) / behavior(action_i):

- IPS = sum(w_i * reward_i) / N, including unmatched observations in N.
- SNIPS = sum(w_i * reward_i) / sum(w_i); null when no observed target mass exists.
- Effective sample size = sum(w_i)^2 / sum(w_i^2); zero without observed overlap.

It rejects malformed distributions, missing rewards, impossible logged choices,
changed action sets, target mass outside behavior support and numerical overflow.
Weights are not silently clipped. Large weights and low effective sample size
signal weak evidence; IPS can exceed 1 in a finite sample. The helper supplies
point diagnostics only, not confidence intervals, rollout approval or a sequential
RL estimate. Its support check cannot prove truthful logging or lack of confounding.

Run the arithmetic and refusal tests without credentials:

```sh
HOME=$(mktemp -d) npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/routing-off-policy-research.test.ts
```

The unequal-propensity fixture observes one successful small-model choice and
nine failed large-model choices. The raw average is 0.1; under a 50/50 target
policy, IPS and SNIPS both recover 0.5 and effective sample size is 3.6. This is
an exactly enumerated synthetic sanity check, not a measured routing improvement.

## READY queue handoff

No router-queue parser or canonical READY example was found in this checkout.
The lines below retain the supplied job's ID, priority, pool, tier and repo syntax,
with an explicit READY state. They are proposed queue entries, not submitted jobs.
All three are offline work with no new tokens, paid calls or protected-path edits.

```text
RQ-ROUTING-BANDIT-REPLAY (P1 READY, pool=codex-personal, tier=frontier, repo=phantom): build offline eligible-action logging schema and seeded partial-feedback replay for Idea 1 in docs/research/routing-rl-ttc.md; accept support refusal, ESS strata and held-out confidence report; IMPACT-SCORE=1.00; no live routing or Tier-1 edits.
RQ-ROUTING-TTC-REPLAY (P1 READY, pool=codex-personal, tier=frontier, repo=phantom): compare stop/continue allocation with uniform attempts on existing authorized traces per Idea 2 in docs/research/routing-rl-ttc.md; accept equal-budget comparison, delayed-verifier and unsolvable-task tests; IMPACT-SCORE=1.17; no new inference or Tier-1 edits.
RQ-ROUTING-RL-BASELINES (P2 READY, pool=codex-personal, tier=frontier, repo=phantom): specify offline sequential-RL baseline and amortization report per Idea 3 in docs/research/routing-rl-ttc.md using replay evidence from RQ-ROUTING-BANDIT-REPLAY and RQ-ROUTING-TTC-REPLAY; accept trajectory-support analysis and fixed-escalation comparison; IMPACT-SCORE=0.40; no training spend or Tier-1 edits.
```
