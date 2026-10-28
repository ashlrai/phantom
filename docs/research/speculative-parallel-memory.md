# Speculative execution, bounded parallelism and agent memory

Research date: 2026-10-26. Repository inspected: `a6f3c323`.
Status: research and offline evaluation tooling, with READY implementation experiments below.
No runtime behavior, provider calls, credentials, paid resources or token allowances change.

## Decision

Prioritize provenance-aware memory selection, then selective read speculation, then
parallel task selection. Phantom already implements bounded best-of-N and offline
memory recall. The opportunity is to spend the existing allowance better, not
multiply workers or add another memory service. Run each experiment independently
before a combined treatment, so a memory improvement cannot conceal a parallelism
regression. The scores below are engineering estimates, not measured outcomes.

This change includes an offline paired-results evaluator and adversarial tests.
The evaluator does not run agents, authenticate observations, grant execution
permission or promote a proposal. No performance benefit has been measured here.

## Verified primary sources

Dates below are submission and revision dates from the linked primary records,
checked on the research date. Claims are the authors' reported results, not
independent replications. Versioned links pin the evidence used in this brief.

| Source | Date and version | Finding and transfer limit |
| --- | --- | --- |
| [Speculative Actions: A Lossless Framework for Faster Agentic Systems](https://arxiv.org/abs/2510.04371v2) | Submitted 2025-10-05; v2 2026-04-23 | Predicts future actions and commits matching predictions. Reports up to 55% prediction accuracy and up to 20% latency reduction across evaluated settings. Its operating-system extension is lossy. The title is not proof that arbitrary shell commands can be speculated safely. |
| [TomasuLLM: Out-of-Order Speculative Execution for LLM Agents](https://arxiv.org/abs/2609.38201v2) | Submitted 2026-09-22; v2 2026-10-01 | Uses isolated copy-on-write execution, dependency/effect tracing and ordered validation. Reports 1.31x on 100 SWE-bench Verified tasks, 1.35x on 28 Terminal-Bench 2.0 tasks, and no false accepts in 4,010 audited validation records. These samples do not establish safety for Phantom's host tools. |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296v3) | Submitted 2025-12-09; v3 2026-04-08 | Tests 260 configurations across six benchmarks. Reports gains on decomposable reasoning and losses on sequential planning, with overhead on tool-heavy tasks. Architecture must match task structure; its predictive model is not a ready-made Phantom routing policy. |
| [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413v1) | Submitted 2025-04-28; v1 | Extracts, consolidates and retrieves salient conversational information. Reports 91% lower p95 latency and over 90% token savings against full-context processing on LOCOMO. That baseline is much larger than Phantom's existing bounded recall; do not forecast those savings here. |
| [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110v11) | Submitted 2025-02-17; v11 2025-10-08 | Organizes structured notes with links and updates their contextual representations. Motivates testing relational recall, but does not establish that generated memory links are reliable evidence or appropriate authority. |

## Existing implementation and constraints

| Surface inspected | Existing behavior | Consequence |
| --- | --- | --- |
| [Best-of-N policy](../../src/core/run/best-of-n-policy.ts) and [execution](../../src/core/run/best-of-n.ts) | Hard limits of eight candidates and two concurrent workers; per-candidate budget splitting; real-judge availability is distinguished from fallback. | Compare against the current bounded implementation. Increasing fan-out is not a new contribution. These are protected Tier-1 paths and are not edited by this work. |
| [Genome recall](../../src/core/genome/recall.ts) | Eligibility filtering, keyword ranking, memory-tier weighting, configurable result count, and explicitly opt-in embedding reranking. | Keep the default offline path and compare within the same context allowance. |
| [Genome consolidation](../../src/core/genome/consolidate.ts) and [store](../../src/core/genome/store.ts) | Consolidation preserves provenance metadata such as source timing and merge count. | Build on existing records rather than replace the store or silently rewrite evidence. |
| [Firm memory](../../src/core/universe/firm-memory.ts) | Immutable daily/master records, source digests and expected-prior checks. | Reuse the provenance design where applicable; do not conflate firm memory with genome recall or claim they are already integrated. |
| [Genome playbooks](../../src/core/genome/playbook.ts) | Synthesis from recalled entries with bounded prompt text. | Count synthesis and maintenance work in any future memory experiment. |

All proposals retain one writer per task/branch, existing sandboxing, enrollment,
Stop/Pause and independent verification. Memory is untrusted task data, never
permission. A synthetic fixture must not enter a production memory store.

## Scoring and shared experiment protocol

`IMPACT-SCORE` is an ordinal 1-10 prioritization tag: expected recurring benefit
(0-4), direct applicability to inspected code (0-3), and feasibility of a bounded
offline pilot (0-3). It is not a probability, ROI estimate or paper metric.

For each idea, freeze 100 task instances, grouped by repository/task family and
split before tuning: 40 development, 60 held-out. Repeat with three paired seeds
for model-backed trials only after separate authorization; do not manufacture
independent samples by treating repeated seeds as new tasks. Use the same source
revision, inputs, model/version, tools, deadline and total token ceiling per pair.
Randomize arm order, record cache warmth and machine load, and include all attempts,
failed branches, cancellation time, judging, retrieval and memory maintenance.
A timeout is a failed task at the full elapsed deadline, not a removed row.
Unknown token accounting makes the comparison incomplete, never zero cost.

Initial work is deterministic fixture replay with no model calls. Any later trial
must fit an already authorized resource allowance; this task authorizes no new
spend or tokens. Freeze task IDs, seeds, cohort labels, code/input digests and raw
observations in a private experiment manifest. Avoid transcripts or secrets in
public reports. Maintain the full task inventory so missing pairs are visible.

Report task success, paired lost/gained successes, p50 and p95 end-to-end latency,
total elapsed time, all tokens per success, CPU time, cancellation waste, and
unsafe/stale accepts. Bootstrap paired differences by task cluster with 10,000
resamples and 95% intervals. Inspect each cohort, especially sequential tasks.
A pilot needs zero unsafe/stale accepts, no observed success-rate decline, at
least 10% p95 improvement, no total elapsed-time increase and no token increase.
Before runtime adoption, require a positive held-out latency improvement interval
and a success-rate lower confidence bound above a preregistered -2 percentage
point noninferiority margin. Expand the sample if inconclusive; 100 tasks is a
screen, not a power claim. Existing policy and review remain necessary.

## Idea S: reuse speculative read results only after exact validation

**IMPACT-SCORE: 8/10** (benefit 3, applicability 2, pilot feasibility 3).
Evidence: Speculative Actions and TomasuLLM above. Adopt the narrow mechanism of
prediction plus validation, not their headline speedup as a forecast.

**Expected impact:** target 10-20% lower p95 on runs dominated by repeated repository
reads, with unchanged model token totals. Reject the idea if hashing, invalidation
and contention consume the saved latency. In a simple model, expected latency
saved is `p*S - (1-p)*R - V`, where `p` is acceptance probability, `S` is overlap
saved, `R` is rejection/replay penalty and `V` is validation overhead. Estimate all
four from traces; this is a heuristic, not a concurrency correctness proof.

**Experiment design:** compare serial reads against one deterministic predicted
read on the same immutable snapshot. Use fixture-derived transitions, not an extra
predictor model. Key reuse by tool/version, normalized arguments, repository and
worktree identity, base revision, dirty-content digest and relevant configuration.
When input completeness cannot be proven, miss the cache. Validate before exposing
the observation and re-read on mismatch. Repository HEAD alone is insufficient.
Fixtures include dirty edits, rename/delete, symlink escape, configuration changes,
identical arguments in another worktree, cancellation, and prediction misses.
Use 50 repeat-read, 25 changed-input and 25 no-predictability tasks.

**Boundary and decision:** whitelist only snapshot file reads and searches. Shell
commands, tests, package managers, network calls and writes are excluded: a test
can mutate state despite being described as verification. No speculative write
can escape, and no result from a rejected branch enters durable memory. Measure
acceptance, wasted reads and digest overhead alongside the shared gates. Retain
serial execution as the fallback. The first READY task is an offline simulator;
any integration touching Tier-1 code requires a separately authorized owner lane.

## Idea P: allocate bounded parallelism by dependency structure

**IMPACT-SCORE: 7/10** (benefit 3, applicability 2, pilot feasibility 2).
Evidence: Scaling Agent Systems above. Independent subtasks and multiple competing
solutions are different experiments; neither justifies concurrent branch writers.

**Expected impact:** target 10-15% lower p95 for decomposable tasks at equal total
tokens, with no benefit assumed for sequential edits. Amdahl's bound limits the
upside: at parallel fraction `f=0.5` and two workers, ideal speedup is only
`1 / ((1-f) + f/2) = 1.33`, before orchestration and verification.

**Experiment design:** 40 independent inspection tasks, 30 dependency-chain tasks
and 30 competing-solution tasks. Compare (A) single execution, (B) current bounded
best-of-N, (C) offline selection of single versus two-way execution using declared
read/write sets and observed critical path. Preserve the current candidate cap,
concurrency cap and total budget. Include controller and independent judge tokens;
an unavailable judge cannot count as accepted success. Treat task-graph metadata
as untrusted: missing dependencies, conflicting paths or unknown effects force
serial execution. No test in this change launches workers.

**Boundary and decision:** inspect in parallel, serialize final edits and proposal
assembly. For separate candidates use isolated worktrees and choose one verified
diff; never concatenate conflicting diffs. Measure makespan, merge conflict rate,
judge disagreement and cancellation waste. Reject policies that help independent
tasks but regress the sequential cohort. Keep recommendations offline until an
owner-lane change can preserve current admission and cancellation gates.

## Idea M: retrieve compact memory with evidence and temporal validity

**IMPACT-SCORE: 9/10** (benefit 4, applicability 2, pilot feasibility 3).
Evidence: Mem0 and A-MEM above. Combine compact retrieval with explicit source links;
do not introduce a graph service or automatic trust in model-generated relations.

**Expected impact:** target 15-25% less recalled context at equal or better task
success, and at least 10% lower p95 end-to-end time. The existing keyword recall is
the primary baseline; full transcript replay is only a diagnostic upper-cost arm.
Any offline indexing, synthesis or consolidation costs belong in the treatment.

**Experiment design:** compare existing recall against a bounded selector over a
fixture memory corpus. Each candidate note has source record ID/digest, repository,
observed revision, validity interval, evidence kind and explicit supersession links.
Retrieve only eligible notes at the query's time; add at most one directly cited
neighbor inside the same fixed token allowance. Missing provenance means abstain.
Leave original entries immutable and represent corrections as new records. Apply
the same source validation to summaries and linked neighbors, not just first hits.
Use 40 recurring-fix tasks, 30 changed-fact tasks and 30 adversarial tasks covering
cross-repository collisions, injected instructions, contradictory summaries,
unsupported links, revoked sources and facts dated after the query.

**Boundary and decision:** split by task family and time before memory construction;
held-out outcomes must never become training memories. A speculative observation is
ephemeral until its branch and source state are accepted. Measure evidence precision,
correct abstention, stale retrieval/acceptance, source coverage and context size in
addition to shared gates. If links do not improve held-out performance over compact
flat recall, retain flat recall. No provider-backed embedding or synthesis is
required for the fixture pilot; no credentials or storage migrations are added.

## Reproducible accounting delivered here

Run the [offline evaluator](../../scripts/research/paired-results.mjs) on JSON:

```sh
node scripts/research/paired-results.mjs /path/to/paired-results.json
```

Input schema, shown with one explicitly synthetic pair:

```json
{
  "schemaVersion": 1,
  "evidence": "synthetic",
  "pairs": [{
    "id": "fixture-read-001",
    "baseline": {"elapsedMs": 100, "tokens": 10, "success": true, "unsafeAccepts": 0, "staleAccepts": 0},
    "candidate": {"elapsedMs": 80, "tokens": 9, "success": true, "unsafeAccepts": 0, "staleAccepts": 0}
  }]
}
```

Each arm records the whole attempt, including rejected work and verification.
`elapsedMs` is positive; counters are nonnegative safe integers. `success` must be
a boolean. Pair IDs must be unique task/seed identifiers. Missing arms, unknown
counters, duplicate IDs and overflowing totals are rejected. A zero-success arm
has null tokens-per-success. The tool reports nearest-rank p95, aggregate ratios
and paired success transitions, retaining failed attempts in all denominators.

Exit 0 means `pilot-screen-pass`; 1 means `hold`; 2 means invalid input or invocation.
Synthetic evidence always holds. Even measured evidence with 100 pairs passing the
numeric screen is only a candidate for deeper review. The tool cannot authenticate
labels, detect omitted tasks, enforce cohort balance, calculate confidence intervals
or certify independence. Those remain manifest/review obligations in the protocol.
The [tests](../../test/research-paired-results.test.ts) exercise failed-attempt cost,
unsafe acceptance, tail versus total latency, unknown counters and misleading data.

## READY router handoff

These lines use the supplied router job envelope, with READY as the job state.
No local router parser or canonical queue file was found in this checkout. EO is
omitted because these experiments have not been scheduled. READY means ready for
offline implementation, not permission to dispatch paid work or change Tier-1 code.
All three are independent; integrated experiments follow only after separate results.

```text
RQ-SPEC-READ-REPLAY (P1 READY, pool=codex-personal, tier=frontier, repo=phantom): Implement Idea S offline snapshot-read replay; 100 frozen tasks; exact input validation, dirty-state and cancellation fixtures; report shared gates and IMPACT-SCORE: 8/10; no provider calls, new tokens, Tier-1 edits or runtime activation.
RQ-MEMORY-EVIDENCE-REPLAY (P1 READY, pool=codex-personal, tier=frontier, repo=phantom): Implement Idea M offline provenance and temporal-validity selector; 100 frozen tasks; compare bounded keyword recall and one-hop links with poisoning and leakage fixtures; report shared gates and IMPACT-SCORE: 9/10; no provider calls, new tokens, store migration or runtime activation.
RQ-PARALLEL-DEPENDENCY-REPLAY (P2 READY, pool=codex-personal, tier=frontier, repo=phantom): Implement Idea P offline dependency-aware replay; 100 frozen tasks; single versus current bounded best-of-N versus selective scheduling at equal budgets; report all cohorts, shared gates and IMPACT-SCORE: 7/10; no provider calls, new tokens, Tier-1 edits or runtime activation.
```
