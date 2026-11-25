# November 2026 frontier scan: research that can improve the factory

**Cutoff: 2026-11-25 UTC.** Public web scan of author papers, engineering
write-ups, product changelogs and contribution policies. Dates below refer to
the linked publication or release, not the date we reproduced a result.
Recent sources took priority; older sources are included where they document
the original pattern or a useful counterexample. Benchmark results and
internal throughput numbers are author-reported, not Phantom baselines.

**Recommendation:** improve how Phantom verifies, integrates and learns from
changes before increasing dispatch. Keep research collection outside the
deterministic [digest-to-job planner](../RESEARCH-LOOP.md). Have research agents
return a checked source, a claim and its limits, an affected file, and a
measurable hypothesis. Feed those through the existing proposal path, not
straight to dispatch. This scan is advisory, not an executable digest or an
activation plan. The [North Star](../NORTH-STAR.md), [autonomy gap map](../AUTONOMY-GAP.md),
and [prior research brief](../UNIVERSE-AUTONOMY-RESEARCH.md) distinguish
operating code, local experiments and ambitions.

## Evidence ledger

### Self-improvement, curricula and verification

| ID | Source | Finding and limit | Phantom surface |
| --- | --- | --- | --- |
| R1 | [Darwin Gödel Machine](https://proceedings.iclr.cc/paper_files/paper/2026/hash/aa5f5e6eb6f613ec412f1d948dfa21a5-Abstract-Conference.html) (ICLR 2026; 2025 preprint) | A tree of retained agent variants lets later runs branch from useful earlier changes, not just the current best. The authors report SWE-bench gains from 20% to 50%; that is empirical selection, not proof that self-edits are safe or generally better. | `src/core/universe/harness-archive.ts` |
| R2 | [Mendel Gödel Machine](https://arxiv.org/abs/2608.07645) (Aug) | Proposes edits by comparing several trajectories from one lineage or comparing different lineages on the same task. A stronger diagnosis than a single failure trace still needs an independent evaluation. | `src/core/universe/harness-archive.ts`, `src/core/improve/lesson-trial.ts` |
| R3 | [Dream-RSI](https://arxiv.org/abs/2609.14858) (Sep) | Replays discovery history to choose better exploration strategies while leaving the base agent fixed. Historical replay can prioritize experiments without proving that the policy will win on tomorrow's jobs. | `src/core/routing/decision-candidates.ts`, `src/core/router/controller-quality.ts` |
| R4 | [Continual Evolution without Forgetting](https://arxiv.org/abs/2611.03219v1) (Nov) | Sequential harness evolution over repair, test-writing and feature tasks can damage previously acquired capabilities. A single aggregate win can hide a regression on a task family. | `src/core/universe/harness-archive.ts`, `src/core/improve/lesson-trial.ts` |
| R5 | [Socratic-SWE](https://arxiv.org/html/2606.07412) (Jun) | Distills skills from coding-agent traces to construct the next round of reinforcement-learning tasks. Phantom can borrow trace-derived lessons and test them on the next eligible task without retraining a model. | `src/core/improve/lesson-trial.ts`, `src/core/improve/lesson-trial-backlog.ts` |
| R6 | [SWE-Growth](https://arxiv.org/abs/2611.23876) (Nov) | Teacher-guided self-play uses tasks the student fails but a teacher can demonstrably solve, reporting gains over student-only self-play. Phantom can borrow the curriculum principle without training models or treating failed attempts as positive examples. | `src/core/run/best-of-n.ts`, `src/core/fleet/best-of-n-ledger.ts` |
| R7 | [SWE-Bench Pro Verified](https://arxiv.org/html/2609.08149v3) (Sep) | Finds that solution leakage and poorly scoped tests undermine benchmark results. Keep acceptance evidence outside candidate control and audit task quality separately from the score. | `src/core/universe/fixed-evaluator.ts`, `src/core/universe/integration-evaluate.ts` |
| R8 | [Multi-step SWE](https://arxiv.org/abs/2611.07166) (Nov) | Evaluates 69 sequences of 5–15 dependent requests on workspaces that accumulate the agent's own code. A good isolated patch does not tell you whether later changes can build on it. | `src/core/universe/integration-plan.ts`, `src/core/universe/integration-evaluate.ts` |
| R9 | [SWE Atlas](https://arxiv.org/html/2605.08366) (May) | Measures codebase Q&A, test writing and refactoring with task-specific checks and rubrics. A repair-only benchmark is too narrow to select the default harness for all engineering work. | `src/core/improve/lesson-trial.ts`, `src/core/router/controller-quality.ts` |
| R10 | [AlphaEvolve impact update](https://deepmind.google/blog/alphaevolve-impact/) (May) | DeepMind reports practical gains on workloads such as Spanner compaction, not just toy objectives. The transferable technique is search against explicit workload metrics; performance on one workload is not authorization to promote on another. | `src/core/universe/harness-archive.ts`, `src/core/universe/preparation-measurement-candidate-comparison.ts` |

### Factories, Git and integration

| ID | Source | Finding and limit | Phantom surface |
| --- | --- | --- | --- |
| F1 | [Redesigning source control at Anthropic](https://www.anthropic.com/research/redesigning-source-control) (Oct) | Anthropic reports going from about 2,500 merged changes a day in May to over 30,000 in September; Scion moves history queries, rebases and merges to the server. It also describes its Antique review surface and automated bisect/revert as applications of cheap source-control queries, not a public specification for its landing policy. | `src/core/fleet/merge-queue-age.ts`, `src/core/fleet/redfix-candidates.ts` |
| F2 | [Scaling Git at OpenAI](https://openai.com/index/scaling-git-at-openai/) (Nov) | Git-compatible Pando coordinates ref updates per branch so unrelated pushes can proceed in parallel; OpenAI reports nearly 5× lower median push latency. The tradeoff is that a multi-branch read need not reflect one instant, so pin exact revisions for cross-branch evidence. | `src/core/fleet/job-latency.ts`, `src/core/fleet/merge-queue-prep.ts` |
| F3 | [Harness engineering with Codex](https://openai.com/index/harness-engineering/) (Feb) | An internal project used isolated worktrees, scriptable verification and iterative agent-to-agent review. It made UI, logs and metrics legible to agents when human QA became the bottleneck. | `src/core/fleet/cross-review.ts`, `src/core/sandbox/worktree.ts` |
| F4 | [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) (living docs) | Checks the proposed change with the latest target plus earlier queued changes, removing the requirement that each author individually update and retest. A green PR head does not by itself prove that the merge group is green. | `src/core/fleet/merge-queue-status.ts`, `src/core/drive/merge-queue-loop.ts` |
| F5 | [Graphite merge queue](https://docs.graphite.com/graphite-merge-queue) (living docs) | Makes predecessor relationships explicit in stack-aware landing, instead of treating dependent PRs as interchangeable. Borrow explicit dependency bookkeeping rather than buying a queue or replacing GitHub's required one. | `src/core/fleet/merge-queue-prep.ts`, `src/core/universe/integration-plan.ts` |
| F6 | [Stripe Minions, part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) (Feb) | Stripe reported over 1,300 agent-produced, human-reviewed merges per week, using isolated devboxes and blueprints with deterministic steps. The lesson is to mechanize known checks and bound retries, not infer that Stripe has removed review. | `src/core/fleet/cross-review-run.ts`, `src/core/sandbox/worktree.ts` |
| F7 | [Stripe Payment Method Factory](https://stripe.dev/blog/stripes-payment-method-factory-orchestrating-agents-for-repeated-custom-integrations) | Decomposes repeated integrations into reusable prompts and separately reviewable changes, with sandbox scenarios producing contract fixtures. Prompts themselves need upkeep when infrastructure changes. | `src/core/universe/portfolio-plan.ts`, `src/core/universe/integration-evaluate.ts` |
| F8 | [StrongDM Software Factory](https://factory.strongdm.ai/) (public case study) | Uses external end-to-end scenarios and digital twins to evaluate user outcomes that in-repo tests can miss. That is an independent signal to add to existing checks, not grounds for skipping them. | `src/core/universe/fixed-evaluator.ts`, `src/core/universe/integration-evaluate.ts` |

**What the sources establish about a moving main.** Scion and Pando solve
source-control load differently; neither public post specifies an internal
merge queue for a verified count of thousands of concurrent agents. Daily
merge counts, Git operations and concurrent agents are different units. The
implementable pattern for Phantom is to prepare and review independent changes
in parallel, pin a stack's actual predecessors, test the combined candidate
via the existing queue, and discard stale evidence when its inputs change.
None of that requires main to go quiet, direct writes to main, or a new
source-control service.

### Prompting the interface, review and community

| ID | Source | Finding and limit | Phantom surface |
| --- | --- | --- | --- |
| C1 | [Conductor: Submit a Prompt](https://www.conductor.build/changelog/0.36.3-submit-a-prompt-sdk-memory-leaks) (Feb) | A Help-menu box collects improvements; Conductor says it runs prompts it likes and merges the result. This verifies selection *before execution*, not how reviewers, spam controls or check gates work. | Existing Prompt-to-PR effort; `src/core/fleet/feedback-triage.ts` |
| C2 | [Conductor: Artifact Publishing and Commenting](https://www.conductor.build/changelog/0.100.0-artifact-publishing-and-commenting) (Nov 24) | Users can annotate an artifact element and send that comment to the agent. This makes iteration concrete; the changelog does not say artifact comments authorize PRs or deployment. | `src/core/verse/preview-api.ts`, `src/core/verse/feedback-api.ts` |
| C3 | [Steve Ruiz: Stay away from my trash!](https://tldraw.dev/blog/stay-away-from-my-trash) (Jan) | tldraw accepts AI-assisted code but closes unsolicited PRs by default and selectively reopens ones it will review. It separates willingness to hear an idea from committing scarce reviewer attention to a patch. | `src/core/fleet/feedback-cycle.ts`, `src/core/fleet/cross-review.ts` |
| C4 | [tldraw: MCP feedback change](https://github.com/tldraw/tldraw/commit/e242d25a658942d32396cfaa2256f2352cffb937) (Nov 19) | A rate-limited MCP tool sends agent bug reports to a separate Discord channel from the in-app form. It demonstrates distinct intake and triage channels, not a form that automatically opens a PR; the cited Ruiz form-to-PR wiring was not independently verified. | `src/core/verse/feedback-queue.ts`, `src/core/fleet/feedback-triage.ts` |
| C5 | [Patrick Collison: Liquid software](https://patrickcollison.com/dispatches/liquid-software) (Oct 31) | A free-text improvements field asks an agent to implement requests in his personal apps; he reports one user made 150 changes in days. That is evidence of low submission friction, not evidence of an automatic PR, review policy, or production Stripe deployment. | Existing Prompt-to-PR effort; `src/core/fleet/feedback-cycle.ts` |
| C6 | [Anthropic: Customize Claude Code with mods in TypeScript](https://claude.com/resources/articles/claude-code-mods) (Oct 1) | Mods are event-handling functions packaged in plugins for Claude Code CLI and desktop; they can change prompts, tool calls and UI. They run with Claude Code's access and are not sandboxed by default, so this is inspiration for narrow extension points, not for loading contributor code. | `src/core/verse/feedback-api.ts`, `src/core/router-gateway/` |

**“Claude Mod”: high-confidence match, not a confirmed attribution.** The name
and timing match Anthropic's official Claude Code **mods** (C6). This is an
extension mechanism, not Claude's model name or a standalone software factory.
No specific mod was named. For the community loop, combine Conductor's
selection-before-execution with tldraw's separation of intake from review:
let anyone surface a useful problem, show a canonical disposition, make
review evidence visible, and credit validated contributions when shipped.
Collison's personal-app experiment motivates lowering submission friction; it
does not justify making every submission executable.

## Ranked changes

Ranked by breadth and depth of the human stop removed, then strength of
evidence and safety cost, not by implementation ease. Under the
[friction-loop doctrine](../doctrine/FRICTION-LOOP.md), capture a baseline by
repo and task class before changing behavior; replay the task that previously
stopped and compare the next matched cohort. Count denominators and unknowns.
If a signal is absent, instrument first; if a metric does not move or its
guardrail worsens, reopen or roll back the bet. Sizes include tests and are
estimates. **Yes** means one work-tier job (≤15 files / 200 changed lines);
**No** gives the first bounded slice. No proposal creates authority, weakens
required checks, or changes protected surfaces.

### 1. Explain moving-main stalls with revision-pinned evidence

Correlate existing prep and queue observations by repo, PR head, target base
and, where visible, ordered predecessors. In a read-only report, distinguish
base movement, stack waits, content conflict and an actual failing check. Use
that reason in existing queue-age triage; don't add a poller or land changes
from this report (F1–F5).

- **Leverage:** Removes repeated manual rebase/CI detective work across lanes.
  **Risk:** Treating a stale head as reviewed; missing or changed SHAs must stay unknown.
- **Files:** `src/core/fleet/merge-queue-age.ts`, `src/core/fleet/merge-queue-status.ts`, `src/core/fleet/merge-queue-prep.ts`, `test/fleet-merge-queue-age.test.ts`, `test/fleet-merge-queue-prep.test.ts`.
- **Signal:** Manual recuts per 100 queued PRs and p90 post-CI wait for eligible PRs; no stale receipt counted as green. **One job: yes**, ~5 files / 180 lines, read-only.

### 2. Add a sealed downstream acceptance scenario

Add a local fixture for two dependent changes whose branch tests pass but
whose combined behavior fails a host-owned scenario. Then wire it into one
existing integration-evaluation path. Keep the evaluator identity and inputs
outside the candidate; retain the exact evaluated artifact and the rejection
reason (R7–R8, F4, F7–F8).

- **Leverage:** Moves cross-change breakage detection before a human repairs
  main. **Risk:** Flaky or mutable scenarios create false confidence; fail
  closed on digest mismatch, and test deterministic fixtures first.
- **Files:** `src/core/universe/integration-plan.ts`, `src/core/universe/integration-evaluate.ts`, `src/core/universe/fixed-evaluator.ts`, `test/universe-integration-evaluate.test.ts`, plus a new fixture under `test/fixtures/`.
- **Signal:** Combined-change failures caught before delivery versus manual
  composition repairs per 100 deliveries; watch false rejections on the
  incumbent. **One job: no**, ~7–10 files / 300–450 lines; build the fixture and negative case first, then wire evidence into delivery.

### 3. Screen existing Prompt-to-PR intake before spending an attempt

Reuse existing reference dedupe and protected-scope checks. Add a shadow
readiness verdict for this intake: link a canonical request when known, ask
for an expected outcome and a way to verify when missing, and keep suspected
bursts held. Treat submitted text as data, never instructions or authority.
Do not create another form, worker, or PR path (C1, C3–C5).

- **Leverage:** Prevents duplicates and unverifiable requests from consuming
  operator triage and worker slots. **Risk:** Rejecting legitimate newcomers;
  show reason codes and sample held items before enforcing.
- **Files:** `src/core/fleet/feedback-triage.ts`, `src/core/fleet/feedback-cycle.ts`, `test/fleet-feedback.test.ts`; attach to the existing Prompt-to-PR producer when its contract is available.
- **Signal:** Duplicate or unverifiable launches and manual clarification
  touches per 100 submissions; measure false holds on sampled actionable
  requests. **One job: yes**, ~3 files / 150 lines for the shadow contract and fixtures, not producer integration.

### 4. Keep harness promotion honest across task families

Use the existing lineage archive and served/holdout lesson trial. Evaluate
one candidate versus the incumbent on fixed repair, test-writing and
refactor cohorts with the same model and envelope. Surface per-family
regressions and absent evidence before recommending promotion; retain the
incumbent identity (R1–R5, R9–R10).

- **Leverage:** Stops a popular lesson or harness becoming the default at the
  cost of recurring regressions in a different lane. **Risk:** Small samples
  and contaminated holdouts; use minimum paired counts and no promotion on
  ambiguous evidence.
- **Files:** `src/core/universe/harness-archive.ts`, `src/core/improve/lesson-trial.ts`, `src/core/improve/lesson-trial-backlog.ts`, `test/universe-harness-archive.test.ts`, `test/improve-lesson-trial.test.ts`, `test/improve-lesson-trial-backlog.test.ts`.
- **Signal:** Previously passing task families regressing and manual harness
  rollbacks per 20 candidate comparisons; track verified yield per family.
  **One job: no**, ~6–9 files / 300–450 lines; start with report-only family
  stratification, then join independent archived comparisons.

### 5. Attach independent review evidence to the exact change

For jobs already routed to cross-review, expose a small read-only handoff.
Reuse the existing head-bound review receipt and verdict; attach exact
check/preview references and actionable remaining gaps. Preserve the
existing stale-head and reviewer-independence checks (F3, F6, C2–C3).

- **Leverage:** Removes the need for an operator to reconstruct what an agent
  reviewed. **Risk:** Familiar-looking green summaries imply approval;
  absent, stale or same-author evidence stays visibly unverified.
- **Files:** `src/core/fleet/cross-review.ts`, `src/core/fleet/cross-review-run.ts`, `src/core/fleet/reviewer-independence.ts`, `test/cross-review.test.ts`, `test/cross-review-deep-verify.test.ts`.
- **Signal:** Manual requests for review evidence per 100 reviewed PRs and
  stale verdicts reused (target zero). **One job: yes**, ~5 files / 180 lines.

### 6. Give community submissions a traceable outcome

Extend the existing feedback digest to join canonical request, admitted job,
PR and verified release where observable. Show action-required, under review,
merged and shipped separately; preview opt-in attribution without generating
external comments. Do not replicate community intake (C1–C5).

- **Leverage:** Gives people a reason to submit again without asking the owner
  where a request went. **Risk:** Misattribution or publishing private data;
  use approved public IDs and omit unverifiable joins.
- **Files:** `src/core/fleet/feedback-cycle.ts`, `src/core/fleet/feedback-ingest.ts`, `src/core/verse/feedback-api.ts`, `test/fleet-feedback.test.ts`; add join fixtures for missing release evidence.
- **Signal:** Manual status chases per 100 submissions, median time to a
  truthful disposition, and share of shipped fixes attributable to external
  submissions. **One job: yes**, ~4–5 files / 185 lines for a read-only digest.

### 7. Turn verified fleet failures into reusable lessons

For a repeated failure class, pair a scrubbed failing attempt with an
independently verified successful attempt on the same task. Propose a
reviewable lesson through the existing improvement backlog; use its current
holdout and leave it unserved if either artifact is missing (R2, R5–R6).

- **Leverage:** Converts manual retries and rescues into a curriculum rather
  than more indiscriminate best-of-N fan-out. **Risk:** Teaching shortcuts,
  leaking traces, or biasing toward tasks a larger model solves; keep bounded
  summaries private and compare on fresh tasks.
- **Files:** `src/core/fleet/best-of-n-ledger.ts`, `src/core/improve/lesson-trial-backlog.ts`, `test/m370.best-of-n-ledger.test.ts`, `test/improve-lesson-trial-backlog.test.ts`.
- **Signal:** Human rescue/retry touches per 100 tasks of that class, with
  served vs holdout accepted outcomes and cost. **One job: yes**, ~4 files /
  190 lines for one failure class in proposal-only mode.

### 8. Make research-to-job attribution auditable

The digest planner already checks source IDs and carries them alongside a job.
Extend that review-only output with the source's checked date and claim,
plus the proposed baseline owner and signal. Reuse its scope, dedupe and
admission; test one real scan-to-proposal handoff using a local fixture.
No new scraper, scheduler or dispatch path (R3, F3, F7).

- **Leverage:** Lets agents review and reuse research instead of asking the
  owner which ideas are real or duplicated. **Risk:** Mistaking a linked
  source for true evidence or attacking the planner via source text; preserve
  the read-only, offline path and require external claim verification.
- **Files:** `src/core/research/proposals.ts`, `src/core/learn/harness-digest-reader.ts`, `docs/RESEARCH-LOOP.md`, `test/research-proposals.test.ts`.
- **Signal:** Human provenance/scope corrections per 100 nominations and
  share of matured proposals with a measured outcome. **One job: yes**,
  ~4 files / 170 lines with optional report fields.

### 9. Measure Git contention before changing checkout policy

Split the existing checkout phase when exact fetch and worktree timings are
available, and compare a bounded, warmed-worktree experiment with the
current path. Differentiate Git contention from model latency, and leave
missing sub-phase boundaries unknown. Do not deploy a new Git backend (F1–F2).

- **Leverage:** Replaces manual debugging of agent startup stalls with
  evidence about the limiting phase. **Risk:** Reusing a stale or mutable
  worktree; isolate candidates and pin the same base in both arms.
- **Files:** `src/core/fleet/job-latency.ts`, `src/cli/fleet-job-latency.ts`, `test/fleet-job-latency.test.ts`, `test/fixtures/job-latency/jobs.jsonl`; the initial experiment supplies boundaries from a local fixture.
- **Signal:** p90 checkout wait, samples with measured boundaries, and
  manual checkout recovery per 100 jobs. **One job: yes**, ~4 files / 160
  lines for report plus fixture, not fleet rollout.

### 10. Shadow comparison of adaptation policies before routing live work

Use the existing off-policy evaluator to replay one narrowly scoped routing
decision against held-out outcomes. Compare the current selector to a rule
that groups prior failure patterns by task class; report disagreements and
insufficient support separately. Require prospective matched evidence
before changing routing; no automatic provider escalation (R3–R4, R10).

- **Leverage:** Focuses live experiments on plausible changes without asking
  the owner to reroute jobs by hand. **Risk:** Logged outcomes do not reveal
  counterfactual quality; don't interpret retrospective wins as causal or
  cross repo/account boundaries.
- **Files:** `src/core/routing/decision-candidates.ts`, `src/core/routing/selector.ts`, `src/core/router/controller-quality.ts`, `scripts/evaluators/routing-off-policy.mjs`, `test/router-controller-quality.test.ts`, `test/routing-off-policy-research.test.ts`.
- **Signal:** Manual reroutes per 100 eligible attempts in a later matched
  cohort; track verified yield and unsupported decisions before treatment.
  **One job: no**, ~6–10 files / 250–400 lines for the full loop; first add a
  read-only replay result, then design prospective validation.

**One-job candidates:** 1, 3, 5, 6, 7, 8 and 9, within the slice stated
above. Split 2, 4 and 10 at their evidence boundaries rather than increasing
the work-tier budget. Start with one bounded job whose baseline shows a real
human stop; if the first cohort shows no improvement, revise the hypothesis
instead of queuing the rest unchanged.
