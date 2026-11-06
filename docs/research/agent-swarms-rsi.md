# Agent swarms and recursive self-improvement

Research date: 2026-10-26. Job: RQ-RESEARCH-SWARMS. Status: research and
experiment specifications, not measured Phantom performance or launch approval.

## Decision

Prioritize a budget-matched topology benchmark, then trace-driven lesson trials.
Keep one writer per task worktree and independent verification. Archive-based
search is promising after those measurements exist. Editable improvement
strategies belong in an offline experiment, outside the promotion mechanism.

A swarm distributes work across agents. Recursive self-improvement (RSI) changes
the mechanism that produces future improvements. Adding workers, retrying a
failed task, and accumulating lessons do not by themselves demonstrate RSI.
None of the evidence below establishes unbounded improvement, production
reliability, or a reason to relax Phantom's authority boundaries.

## Dated primary evidence

Versions are pinned so later revisions cannot silently change these claims.
Numbers describe the authors' experiments, not forecasts for Phantom.

| Source | Dates and version | Finding and limitation |
| --- | --- | --- |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296v3) | Submitted 2025-12-09; v3 2026-04-08 | Across 260 configurations and six benchmarks, relative changes span +80.8% on decomposable financial reasoning to -70.0% on sequential planning. Task structure and coordination matter; this is not a coding-specific sizing rule. |
| [How we built our multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system) | Engineering report 2025-06-13 | Internal research evaluation reports 90.2% improvement over a single Opus 4 agent. Multi-agent usage was about 15 times chat usage, not 15 times the single-agent baseline. Different models and larger compute make this insufficient evidence for equal-budget swarm gains. |
| [Darwin Godel Machine](https://arxiv.org/abs/2505.22954v3) | Submitted 2025-05-29; v3 2026-03-12 | Maintains an archive of agent variants and empirically evaluates code changes. Reports SWE-bench improvement from 20.0% to 50.0%. This is benchmark-specific empirical selection, not a proof that arbitrary self-modification is beneficial. |
| [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457v2) | Submitted 2025-07-25; v2 2026-02-14 | Uses trajectory reflection and a Pareto frontier to evolve prompts. Reports up to 35 times fewer rollouts than GRPO across its experiments. Prompt optimization is useful evidence for bounded adaptation, not evidence of autonomous weight improvement. |
| [Hyperagents](https://arxiv.org/abs/2603.19461v1) | Submitted 2026-03-19, v1 | Makes both task behavior and the meta-level modification procedure editable; reports cross-domain transfer of improvements to the improvement process. Research evidence does not establish safe production self-editing or indefinite acceleration. |

## Phantom starting point

- The [swarm planner](../../src/core/swarm/planner.ts) asks for independent
  build tasks with phased dependencies, at most six tasks per phase and eighteen
  overall. A prompt claiming independence is not evidence that edits are disjoint.
- The [swarm runner](../../src/core/swarm/runner.ts) already slices budgets using
  spent and reserved usage. Any experiment must count coordinator, workers,
  retries and verification within the same total, rather than add worker budgets.
- [Improvement discovery](../../src/core/improve/discover.ts) carries evidence,
  an evaluation plan and a metric into proposals. Extend that workflow instead
  of creating a second autonomous proposal channel.
- [Lesson trials](../../src/core/improve/lesson-trial.ts) already assign a
  deterministic holdout and count merged, unreverted work. Its minimum of three
  finished tasks per arm is a reporting threshold, not statistical power for
  the experiments proposed here.
- [Exact-commit measurement](../../src/core/improve/measure.ts) and
  [promotion](../../src/core/improve/promote.ts) are existing boundaries to
  preserve. A successful model evaluation alone must never authorize a merge.

## Experiment protocol shared by every idea

These are proposed experiments. No model calls, paid resources, new credentials,
or production changes are required by this research change. First implement
fixture-based runners; execute model trials only within separately authorized
capacity. Never print credentials or include private raw traces in reports.

Freeze task IDs, repository SHAs, model versions, tool versions, scoring commands,
timeouts and total token ceilings before comparing arms. Record candidate and
parent hashes, seed, task class, outcome, wall time, measured tokens, verifier
result and failure reason. Unknown usage stays unknown, not zero. Include failed
and timed-out attempts in denominators; record launch failures separately.

Use disjoint development, selection and final holdout tasks, split by issue family
to reduce near-duplicate leakage. Candidate agents cannot edit evaluators or read
final holdout solutions. Select on the selection split, then evaluate the chosen
candidate once on the frozen holdout. Rotate the holdout for subsequent rounds.
Run paired trials on the same tasks with randomized arm order and three seeds.
Bootstrap paired differences by task, not by individual seed, with a fixed
bootstrap seed and 10,000 resamples. Report 95% intervals and all strata, including
negative results. The sample sizes below are bounded pilots, not power claims;
an interval spanning zero means inconclusive and does not justify rollout.

Primary quality is the fraction of tasks passing independent functional checks.
Report tokens per verified success, total tokens including failed attempts,
p50/p95 elapsed time and conflict or verifier-disagreement rate. A zero-success
arm has undefined cost per success. Missing usage prevents cost-based acceptance.
Keep the incumbent whenever evidence is incomplete. Later online validation must
also track merged-and-unreverted outcomes over a fixed seven-day observation window.

IMPACT-SCORE is an ordinal priority from 1 to 10, not a measured effect size:
score = expected value (1-5) + evidence fit (1-3) + ease of bounded testing (1-2).
The numeric targets below are hypotheses chosen for engineering usefulness.

## Idea 1: Match swarm topology to task dependencies

**IMPACT-SCORE: 9/10** (value 4 + fit 3 + testing 2).

**Evidence:** Scaling Agent Systems and Anthropic's 2025 report above support
selective parallelism. **Expected impact:** at least 20% lower median latency
on independent tasks without lower success, while avoiding wasted fan-out on
sequential work. This is an inference to test, not a published Phantom result.

**Experiment design:** collect 60 historical, reproducible tasks, twenty each
independent, shared-file and sequential. Compare one agent, two workers plus
coordinator, and four workers plus coordinator at identical total token and
wall-time ceilings. Give each arm the same tools and model. Freeze dependency
labels before execution. Use isolated worker worktrees and a single integration
writer. Count integration failures as failures. Compare against an equal-budget
single agent with retries so additional search is not mistaken for coordination.

**Acceptance:** independent-task median latency improves at least 20%, its paired
95% interval excludes zero, and quality difference has a nonnegative lower
confidence bound. Require no quality loss in other strata before general use;
otherwise restrict any later rollout to the validated class. Abort on budget
violation. **Landing:** a source-only benchmark adjacent to the existing planner;
no dispatch or permission changes. Start with offline fixtures in READY item 1.

## Idea 2: Evolve lessons from failure traces with a held-out comparison

**IMPACT-SCORE: 8/10** (value 4 + fit 2 + testing 2).

**Evidence:** GEPA above motivates reflection over trajectories rather than
scalar scores alone. **Expected impact:** five percentage points more verified
success at equal inference budget through concise, task-specific lessons.

**Experiment design:** develop candidate lessons on 30 sanitized failure traces;
select on 30 separate tasks; freeze one lesson set and compare it with no lessons
on 60 final tasks. Ablate reflection by comparing a same-length generic checklist
on the selection split. Account for lesson generation and serving tokens, and
report optimization cost separately from inference cost. Treat retrieved lessons
as untrusted task data. Adapt the existing lesson-trial assignment for later
online validation, without changing current eligibility or promotion decisions.

**Acceptance:** final quality gain at least five points with a positive lower
confidence bound, total inference tokens no greater than baseline, and no new
verifier failures. Otherwise retain existing lessons. **Landing:** a fixture-based
trial report and candidate lesson artifacts; no automatic knowledge activation.

## Idea 3: Preserve diverse candidate lineages instead of only the latest winner

**IMPACT-SCORE: 7/10** (value 4 + fit 2 + testing 1).

**Evidence:** DGM above supplies the archive mechanism. **Expected impact:** ten
percent more verified improvements per fixed search budget by retaining useful
alternatives that a greedy chain would discard.

**Experiment design:** compare a greedy incumbent-only chain with an archive of
at most eight candidates across ten historical failure families. Cap each search
at twenty proposals and identical total tokens. Keep parent hashes and behavioral
coverage signatures; select diverse candidates on development/selection tasks
only. Freeze winners before testing on sixty held-out tasks. Repeat with three
seeds. Ablate diversity using an equally sized random-parent archive.

**Acceptance:** at least 10% relative gain in accepted improvements per budget,
positive paired interval across failure families, no final-holdout regression,
and reproducible lineage records. If baseline finds zero improvements, report
absolute counts instead of a relative percentage. **Landing:** offline archive
simulation consuming redacted proposal evidence. Do not change live proposal
selection until the evaluation establishes value.

## Idea 4: Evaluate changes to the improvement strategy itself

**IMPACT-SCORE: 5/10** (value 3 + fit 1 + testing 1).

**Evidence:** Hyperagents above distinguishes an editable improvement procedure
from a fixed search loop. **Expected impact:** ten percent fewer proposal attempts
to obtain the next independently verified improvement on unseen task families.

**Experiment design:** freeze the task agent and compare a fixed proposal strategy
with an editable strategy artifact restricted to reflection templates and parent
selection parameters. Train on ten failure families and evaluate on ten disjoint
families, three seeds, twenty proposals maximum per family and equal total token
ceilings. Record improvement yield per generation, not just best final score.
Treat capped runs without success as censored; report success-at-cap alongside
attempts-to-success to avoid rewarding strategies that succeed rarely.

**Acceptance:** at least 10% reduction in attempts with a positive paired interval,
no lower success-at-cap, and transfer to the untouched families. Any attempted
evaluator, permission, protected-path or budget modification rejects the candidate.
**Landing:** offline simulation only. The experiment cannot modify its own scoring,
promotion or execution boundary. Defer live recursive modification even if this
pilot succeeds; that requires a separate design and authority review.

## Delivery and validation

This change chooses the READY-lines option. The documentation map links here via
a source URL so the curated npm documentation does not acquire an unpackaged
relative dependency. The navigation regression test checks this report's local
implementation links and detects a broken implementation reference. Existing
package navigation tests exercise the new map entry in the shipped docs layout.
These tests validate navigation, not the truth of paper claims or experimental gains.

Run typecheck, lint, check:docs and the documentation-navigation suite with a
temporary test home. No production code is changed, so there is no runtime
activation or rollback migration. No dead runtime code was touched.

The task's later no-commit, no-push and no-publish instruction supersedes the
queue's publish.sh request. Leave one reviewable uncommitted change and bridge
notes. No publish.sh exists in this checkout; do not invent a publishing command
or claim a PR exists. The authorized handoff process must publish later.

## READY router queue lines

Use the supplied queue envelope with READY in the priority/status slot. No queue
parser or canonical READY example exists in this checkout. These are copyable
handoff proposals, not submitted jobs; pool follows this job's codex-personal
assignment. EO is omitted because no execution deadline was assigned. Each item
starts offline and requires no new tokens or credentials.

```text
RQ-SWARM-TOPOLOGY-EVAL (P1 READY, pool=codex-personal, tier=frontier, repo=phantom): Build the offline paired topology benchmark specified in docs/research/agent-swarms-rsi.md Idea 1; fixtures cover sequential dependencies, shared-file conflicts, missing usage and exhausted aggregate budgets; emit per-stratum quality, latency and cost without launching agents; IMPACT-SCORE=9/10.
RQ-RSI-LESSON-EVAL (P1 READY, pool=codex-personal, tier=frontier, repo=phantom): Build the offline lesson comparison specified in docs/research/agent-swarms-rsi.md Idea 2; fixtures cover issue-family leakage, failed attempts, unknown usage and inconclusive intervals; preserve existing lesson eligibility and activation; IMPACT-SCORE=8/10.
RQ-RSI-ARCHIVE-EVAL (P2 READY, pool=codex-personal, tier=frontier, repo=phantom): Build the bounded archive simulation specified in docs/research/agent-swarms-rsi.md Idea 3 after RQ-SWARM-TOPOLOGY-EVAL; test parent lineage, eight-candidate cap, equal search budgets and zero-success denominators; no live selection changes; IMPACT-SCORE=7/10.
RQ-RSI-META-EVAL (P2 READY, pool=codex-personal, tier=frontier, repo=phantom): Build the offline strategy experiment specified in docs/research/agent-swarms-rsi.md Idea 4 after RQ-RSI-ARCHIVE-EVAL; test censored failures, fixed evaluators, disjoint task families and rejection of boundary edits; no live self-modification; IMPACT-SCORE=5/10.
```
