# Fleet architecture research: spend capacity on durable outcomes

Research date: **2026-11-14**. Job: **RQ-RESEARCH-FLEET-1**.
Baseline: `96a5a9be22a` in `ashlrai/phantom`. Research and proposed experiments
only; no runtime, quota, queue, authority, billing or deployment change.

## Recommendation and ranking

Prioritize complete evidence at the boundaries between existing systems:
provider observation to admission, worker heartbeat to fenced recovery, and
verified patch to observed post-merge outcome. Increasing concurrency before
closing those joins risks counting the same allowance twice and rewarding
activity that never becomes stable shipped work.

The ranking is an engineering judgment, not measured Phantom improvement.
Impact is 1–5; confidence is high/medium; effort S/M/L means a bounded follow-up,
several integration slices, or a cross-system program. Score follows the existing
[research-loop convention](../RESEARCH-LOOP.md): impact × confidence weight
(high 1.0, medium 0.6) minus effort penalty (S 0, M 0.5, L 1).
Equal scores are ordered by prerequisite value. Each mechanism below specifies
an experiment; none is an instruction to enqueue or activate it.

| Rank | Mechanism and incremental deliverable | Impact / confidence / effort / score | Why now |
| --- | --- | --- | --- |
| 1 | Bind shared funding buckets to admission receipts; simulate concurrent consumption | 5 / high / M / 4.5 | Product and CLI names are not independent quota supplies |
| 2 | Join dispatch, verification, merge and observed durability before quality credit | 5 / high / M / 4.5 | Prevents fast, weak patches from improving a lane's rank |
| 3 | Reconcile on local events with independent liveness and progress clocks | 4 / high / M / 3.5 | Reduce idle detection delay without a model on every tick |
| 4 | Publish bounded context manifests backed by immutable evidence references | 4 / high / M / 3.5 | Reduce repeated discovery and stale handoff decisions |
| 5 | Calibrate pass^k estimators and report task-level uncertainty | 3 / high / S / 3.0 | Existing plug-in consistency is not the paper's unbiased estimator |
| 6 | Extend reset-fit planning with conservative duration fit and shared demand | 4 / medium / M / 1.9 | Recover useful expiring capacity while retaining reserves |
| 7 | Replay fairness and queue aging after capability filtering | 4 / medium / M / 1.9 | Utilization ranking alone can repeatedly defer large or scarce jobs |
| 8 | Compare constrained outcome routing and selective fan-out on held-out tasks | 4 / medium / L / 1.4 | Useful after evidence joins; premature live learning obscures causality |

First sequence: 1 and 2 establish trustworthy inputs; 3 and 4 make those inputs
available promptly; 5 improves interpretation; 6–8 compare policies offline.
No claimed percentage gain below is a production result. Acceptance thresholds
are proposed experiment criteria, not new fleet gates.

## Existing capabilities and overlap boundaries

This sweep extends the repository's mechanisms rather than proposing replacements.
The supplied live claims concern PR rebases. An exact open-PR search for
`RQ-RESEARCH-FLEET-1` returned none on the research date; the requested report
was absent. This is a point-in-time check, not proof that future follow-ups have
no owner. Recheck claims and PRs before implementing any follow-up.

| Existing reference | Established behavior | Delta worth researching |
| --- | --- | --- |
| [Tick phases](../daemon-tick-phases.md) | Deadlines, abort/grace, detached turns, refusal to overlap abandoned ticks | Distinguish process life, useful progress and lease ownership; replay cadence changes |
| [Reset-aware scheduling](../RESET-AWARE-SCHEDULING.md) | Account-qualified deadlines, duration quartiles, binding windows and admission rechecks | Shared funding identity across surfaces; demand and duration-tail simulations |
| [Provider aggregation types](../../src/core/resources/provider-aggregation-types.ts) and [implementation](../../src/core/resources/provider-aggregation.ts) | Exact funding scopes and proof-gated qualitative pool grouping; no numeric totals or execution authority | Source-qualified relation producers and a separately validated admission projection; never use display grouping as a permit |
| [Work market](../QUEUE.md) and [hysteresis](../ROUTE-HYSTERESIS.md) | Capability/tier/cost filters, utilization/outcome ranking, atomic slot rechecks, route receipts | Bounded fairness and age within permitted priority groups; retain residency and move limits |
| [Agent Bus v2](../AGENT-BUS.md#v2) | Context/work bodies, resource claim leases and overlap protocol | Evidence-backed context manifests and delivery reconciliation, without another claim store |
| [pass^k suite](../EVAL-PASSK.md) | Clean trials, dataset hashes, pass@k, plug-in pass^k and advisory scores | Version estimator semantics and avoid pooling heterogeneous tasks |
| [Fleet eval report](../../src/core/fleet/eval-report.ts) | 72-hour covered observation requirement, unobserved cohorts and Wilson ranking | Exact decision-to-outcome joins and coverage audits before policy consumption |
| [Learning eligibility](../../src/core/learning/learning-eligibility.ts) | Explicit observation-only projection; policy and recursive-learning eligibility remain false | Investigate missing denominator and propensity evidence; preserve that refusal |
| [Routing research](../research/routing-rl-ttc.md) | Bandit/TTC experiments and an offline importance-weighting diagnostic already exist | Reuse the evaluator and task splits; add provider-window and delayed-outcome scenarios |
| [A2A/OSS survey](../research/RQ-OSS-A2A-ORCH-1.md) | Prior protocol/runtime comparison | Reuse its survey; current bus ownership is governed by today's contract, not its historical “contract-only” description |

## Provider evidence: quota is a product/account/window graph

All provider pages in this section were opened on **2026-11-14**. Public plan
documentation establishes general semantics, never the enrolled account's actual
balance, execution identity, contractual entitlement or reset timestamp.
No private dashboard, credential file or provider inference was used.

| Product or surface | Verified documentation fact | Fleet implication and unresolved evidence |
| --- | --- | --- |
| Anthropic Claude Code subscription | Status-line metadata exposes optional five-hour/seven-day percentages and reset instants. Windows may be independently absent; subscription data appears after a response. `/usage` can display a last-known snapshot when its request fails. [Status line](https://code.claude.com/docs/en/statusline), [costs](https://code.claude.com/docs/en/costs) | Preserve original observation time and account/model scope. Absence is unknown, not unused quota. Do not generate a paid turn merely to populate a meter or refresh last-known data by rereading it. |
| Anthropic API | Organization-level token-bucket limits refill continuously; short bursts can exhaust them. Monthly spend-cap exhaustion differs from transient throttling and may lack `retry-after`. [API limits](https://platform.claude.com/docs/en/api/rate-limits) | Subscription windows, RPM/TPM admission and dollar funding are separate. Classify the documented error before retrying; a spend-cap refusal is not a short retry opportunity. API execution remains subject to existing commissioning. |
| OpenAI signed-in Codex | Current pricing says local messages and cloud chats share allowance; weekly limits may apply. Plus/Standard Business estimates use five-hour periods, while Pro currently has no five-hour limit. Consumption varies by task and model. [Official pricing](https://learn.chatgpt.com/docs/pricing) | Never hard-code “all Codex seats have 5h+weekly.” Bind observations to plan, bucket, account and model/effort. Native evidence must qualify any deadline; API-key spend is a separate funding path. Public estimates cannot yield tokens remaining. |
| xAI/Grok API | API team limits are per model in RPS and TPM, with console-specific tiers; excess returns 429. [Rate limits](https://docs.x.ai/developers/rate-limits) | Several API keys in one team do not prove independent capacity. Consumer Build, Bot and API balances remain distinct unless source evidence proves a particular shared pool. Do not map a consumer weekly reset onto the API. |
| Cursor and Grok subscription | Current plans describe a weekly pool shared across Cursor and Grok surfaces; third-party models use prepaid credit. Legacy Cursor plans retain different monthly pools and on-demand usage. [Models and pricing](https://cursor.com/docs/models-and-pricing) | Two lane labels can consume one allowance. Store plan generation and actual linked funding identity; cross-vendor labels do not prove independence or equivalence. Legacy/unknown plans require their own observations. Never enable top-ups or paid fallback to improve utilization. |
| Devin | Self-serve Pro/full seats have daily and weekly allowance; Max has weekly allowance without a daily cap. Sessions, CLI and Desktop share quota. Purchased credits roll over without expiry; Teams credits are shared. [Self-serve billing](https://docs.devin.ai/admin/billing/self-serve) | Preserve the distinction between native included quota, enterprise ACU observations and purchased credits. The existing tracked ACU reader is not proof of a self-serve deadline or no-spillover boundary. General plan facts do not commission a new adapter. |
| Google Antigravity | Pro/Ultra plans describe five-hour refreshes plus weekly limits; free usage is weekly. AI-credit overages have Never/Always settings, and usage is workload-dependent. [Plans](https://antigravity.google/docs/plans/) | Keep short and weekly scopes separate, and model any verified overage boundary separately from inclusion. A documented UI setting alone does not prove an account-bound, machine-verifiable execution fence. |
| Gemini Developer API | Limits are per project, not API key; RPM, input TPM and RPD can all bind. Daily quotas reset at midnight Pacific. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) | Account for all keys/tools sharing a project. Compute daily boundaries with the provider timezone including DST, not a constant UTC offset. Do not borrow Antigravity or Gemini CLI subscription quota for API admission. |
| z.ai GLM Coding Plan | Supported tools share a subscription quota; five-hour and weekly limits coexist. The FAQ says weekly periods follow an order-based seven-day cycle; reset cards can re-anchor periods. Supported plan calls do not draw the ordinary account balance. [FAQ](https://docs.z.ai/devpack/faq) | Record actual period observations and supported execution path; several tools are not several allowances. Reset-card behavior makes an old predicted boundary invalid. Do not redeem benefits or invent an undocumented quota endpoint. |
| StackSync | Its public documentation describes data synchronization: batch changes, smooth per-app rate limits, and largely avoid calls when data is unchanged. [Rate-limit management](https://docs.stacksync.com/two-way-sync/features/manage-api-rate-limits) | Borrow change-driven reconciliation and shared upstream accounting. This page does not establish any model-seat quota/reset API for Phantom's `stacksync` participant; leave those fields unknown. |

The current Codex and Cursor pages differ materially from older generic quota
summaries. Treat documentation drift as a reason to refresh adapter fixtures,
not permission to rewrite account observations. The earlier
[provider probe inventory](../research/provider-usage-probes.md) remains useful
for locating readers; its dated product assumptions require revalidation.

### Mechanism 1: source-qualified shared-bucket admission

Extend the existing funding-scope vocabulary with a source-owned mapping from
execution surfaces to the same verified allowance. Keep distinct dimensions:
provider, product/plan generation, opaque funding-account identity, model scope,
unit, window identity, original observation time, reset semantics and evidence
expiry. `null` never means “matches every account.” Retain independent windows
within a pool; weekly and five-hour percentages must not be added or averaged.

A prospective admission projection should record the bucket-version observed,
in-flight local allocations and the execution-profile binding. Serialize local
reservation and launch decisions for a shared bucket, then revalidate at every
new contact. Reservations coordinate this fleet; they cannot reserve provider
quota against interactive use, another machine or another customer.

For provider-reported absolute units, reserve a conservative bounded requirement
in those same units. If the provider supplies only percentage observations,
retain existing headroom policy and concurrency controls; do not invent a token
or task reservation by converting percentage to tokens. Explicitly report
unmodeled external consumption and reconcile from new authoritative readings.
An unknown sharing relation is uncertainty, not evidence of independent supply.

**Experiment:** extend existing pool-accounting fixtures with two surfaces sharing
one bucket, independent accounts, mixed model windows, stale proofs, account
switches, external consumption, out-of-order readings and simultaneous launches.
Compare baseline decisions against a reference shared-bucket simulation.
Acceptance: no duplicate local allocation of the same absolute units, no
percentage conversion, no unknown-plan activation, and unchanged existing
admission decisions where no qualified sharing proof exists. Mapping absence
must remain visible as incomplete coverage, not “zero shared accounts.”

Integration seams: existing provider aggregation and quota/admission services,
not a second budget database. Source proof producers and any admission consumer
are separate follow-ups; the present display aggregator explicitly grants none.

### Mechanism 6: reset-fit scheduling with a horizon

Reuse qualified deadline and duration evidence from reset-aware scheduling.
Prefer eligible useful work likely to finish before an expiring included window,
then replan on meaningful events. Do not treat continuously refilling API buckets
or non-expiring purchased credits as use-before-reset inventory.

For comparable jobs, simulate a conservative fit rule: remaining time exceeds
observed duration p90 plus measured verification/handoff time and clock-error
margin. Compare it with today's p75-based preference; p90 is a candidate policy,
not a replacement fact. Missing duration, scope mismatch or too few comparable
samples means unknown fit. Avoid scheduling a long job merely because its lane
has the largest unused percentage.

For absolute, commensurate native units, compare demand until reset against
available units after reserves and existing reservations. Admit against every
binding constraint; never sum five-hour and weekly supply. For percentage-only
plans, rank measured fit without estimating a knapsack capacity in tokens.
Treat ambiguous re-anchoring, future-dated observations and account changes as
invalidating the forecast. A predicted reset schedules a refresh, not a grant.

**Experiment:** replay recorded duration distributions and synthetic shared-window
traces with long tails, missing history, late resets and demand spikes. Measure
verified useful completions before reset, post-reset continuation, rejected
contacts, queue age and unused *measured native units* where available. Require
zero reserve/authority violations and no quality reduction; report unknown
quantity coverage. Preserve current hysteresis and immutable launched routes.

## Heartbeats, supervisors and adaptive cadence

Temporal separates heartbeat timeouts, per-attempt execution bounds and total
retry bounds; heartbeat progress can support resumption. Kubernetes separates
lightweight node leases from broader status reporting. The phi-accrual paper
models failure suspicion from heartbeat arrival distributions rather than a
single universal timeout. These are reference semantics, not a recommendation
to install either platform. [Temporal failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures),
[Kubernetes leases](https://kubernetes.io/docs/concepts/architecture/leases/),
[Hayashibara et al., 2004](https://dspace02.jaist.ac.jp/dspace/bitstream/10119/4784/1/IS-RR-2004-010.pdf).

### Mechanism 3: event-driven reconciliation and three independent clocks

Keep the existing phased supervisor and define three observations per attempt:

| Clock | Evidence | What expiry permits |
| --- | --- | --- |
| Liveness | Authenticated local runner heartbeat and sequence | Probe or suspect the worker; not success or immediate reassignment |
| Progress | Checkpoint, completed tool phase, verification artifact or bounded output counter | Classify stalled work even when the process remains alive |
| Ownership | Existing claim lease and execution fencing generation | Recover only through the authoritative claim protocol and reject stale writers |

A live process can make no progress; a quiet model call can still be healthy.
Use stage-specific progress expectations. Never renew ownership solely because
a supervisor thread is alive. Before recovery, reconcile the current attempt and
late results, then require the existing authoritative claim/fence transition.
A bus label or unverified heartbeat does not authenticate a worker.

Use durable events to mark reconciliation inputs dirty: queue arrival, attempt
finish, claim expiry, provider backoff change, verified capacity refresh and
repository readiness. Coalesce bursts by scope and serialize the existing tick;
retain a periodic sweep for lost events. A wake contains a bounded reference,
not a task instruction or a new execution permit.

A proposed timer is the earliest applicable deadline among next lease renewal,
backoff expiry, qualified reset refresh, dirty-scope debounce and maximum idle
sweep. Apply jitter only within slack: never delay lease renewal or a mandated
control check. Separate monotonic elapsed-time measurement from provider UTC
reset instants; host sleep or clock correction triggers fresh reconciliation.
Cheap lease and Stop checks must continue while expensive planning backs off.
The loop does not perform inference when nothing relevant changed.

Adaptive control: lengthen idle sweep after repeated no-change passes, shorten on
runnable arrivals, and reduce planning/launch concurrency after measured overload.
Use explicit min/max intervals, cooldown and bounded retry budgets. Honor
provider `retry-after` when supplied; classify billing/auth/invalid-request
failures separately. A transient throttle changes admission/backoff, not the
current route-hysteresis exception list. Phi suspicion is initially diagnostic
only; learn distributions by stage/host and report cold-start uncertainty.

**Experiment:** replay idle, bursty and outage traces against fixed cadence.
Inject duplicate/lost events, stuck awaits, detached completion, heartbeat loss,
clock jumps and machine sleep. Acceptance: no overlapping ticks or duplicate
side effects, bounded recovery via the existing fence, no new paid probes, and
lower p95 runnable-event-to-plan delay without more idle expensive passes.
Measure false-stall rate separately from actual dead-worker detection latency.
Timeout is a supervisor outcome, not proof that the underlying run was killed.

## Shared context, evidence and the work market

A2A provides task/message/artifact objects, logical context identifiers and
polling/streaming/push update paths. Those identifiers organize work; they do
not establish a shared memory trust boundary. Anthropic's long-running harness
uses durable progress artifacts to bridge sessions. Borrow explicit lifecycle
and artifact references while retaining Phantom's existing bus and claim store.
[A2A specification](https://a2a-protocol.org/latest/specification/),
[long-running harnesses](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents).

### Mechanism 4: small context manifests over immutable evidence

Compose a task-scoped manifest from existing observations, not a broadcast of
every transcript. Include intent/acceptance version, repository commit, job and
attempt references, relevant claim scopes, dependency state, verified facts,
unresolved contradictions, artifact references/hashes, source timestamps and
coverage limitations. Pin policy/schema versions and reader cursors. Label
agent hypotheses separately from command/test receipts and provider evidence.

Use three layers: a small stable repository map; bounded task-specific context;
and recent delta/checkpoint references. Fetch detailed evidence on demand with
recipient-scope checks. Immutable content identity detects change; it does not
prove truth or access authorization. Signatures establish custody, not semantic
correctness. A mutable URL needs a captured version/hash before evidentiary use.

Keep operational identity and private contents in their existing custody.
Share scoped metadata through existing bus `refs`; no auth, raw environment,
chain-of-thought, unlimited logs or private-to-public replication. Apply access
control at read time, not only when a reference was first published. Reject
expired or wrong-revision facts and surface contradictions instead of letting
the latest summary silently win. Retrieved and remote text remains untrusted.

Use per-consumer sequence cursors, idempotent event IDs, bounded retention and
snapshot-plus-delta recovery after a cursor gap. A durable outbox/inbox boundary
can reconcile interrupted publication; acknowledgments mean delivery, not task
completion. A2A adaptation belongs at an edge adapter; avoid replacing the bus
or creating an unauthenticated webhook merely to obtain push delivery.

**Experiment:** hand the same frozen task to a clean session with either current
handoff text or a bounded manifest. Measure discovery calls, context tokens,
wrong-revision decisions, duplicate claims and independently verified completion.
Inject stale references, reordered deltas, ACL revocation, conflicting receipts
and malicious instructions in evidence. Acceptance: no claim/ACL bypass, all
reported facts trace to readable pinned artifacts, and noninferior task success.
Prefer a deterministic manifest builder before a model-generated memory system.

### Mechanism 7: capability-first market, then bounded fairness

Use the existing market's eligibility filters first. Within the same priority
and compatible preference groups, compare age-aware deficit scheduling against
current utilization ranking. Give each eligible owner/repository a bounded share;
charge only observed, comparable resource use and carry a limited deficit.
Do not let aging jump incident priority, mint quota or move a launched job.

Dominant Resource Fairness is a useful reference when workers compete for
multiple resources such as RAM, worktrees and provider request capacity. Its
fairness objectives are not equivalent to shortest completion time; a November
2026 theoretical analysis studies precisely that distinction. Different quota
units require resource-specific capacities, not one percentage sum.
[DRF, NSDI 2011](https://www.usenix.org/conference/nsdi11/dominant-resource-fairness-fair-allocation-multiple-resource-types),
[Blue et al., 2026-11-05](https://arxiv.org/abs/2611.07905).

Backfill short work only when the simulation preserves a measured reservation
for an older feasible job. Unknown duration is not “fits.” Split only naturally
independent jobs with bounded claims; retain `exclusive=true`. Scarce-capability
jobs must not lose their only compatible executor to universally runnable work
indefinitely. Respect owner-isolated resource contributions and local-only jobs.

**Experiment:** replay a frozen queue with burst arrivals, scarce capabilities,
large jobs, unknown durations and heterogeneous quota buckets. Compare priority
violations, oldest runnable age, p95 wait by class, completion rate and resource
idle time. Acceptance: zero priority/eligibility/hysteresis violations and a
predeclared improvement in worst-served runnable age without lower verified
throughput. Missing scheduling events remain unmeasured, never zero latency.

## Self-improving evaluation with delayed outcomes

### Mechanism 5: label the estimator before using the score

The original tau-bench definition measures all-k-trials success, contrasting it
with at-least-one success. Its finite-sample unbiased estimate differs from
Phantom's current plug-in estimate. [Yao et al., 2024, metric definition](https://arxiv.org/html/2406.12045v1).

For one task, let n be trials, c successes and k no larger than n:

- pass@1: c/n.
- pass@k: 1 − C(n−c,k)/C(n,k), with C(a,k)=0 when a<k.
- Unbiased pass^k estimate: C(c,k)/C(n,k).
- Current Phantom plug-in pass^k: (c/n)^k; identify it explicitly as plug-in.

Synthetic example: n=8, c=6, k=4 yields pass@1=0.75, pass@4=1,
combinatorial pass^4=15/70≈0.2143, and plug-in pass^4≈0.3164.
The difference is finite-sample estimator behavior, not a model regression.
Compute task-level values before macro averaging; exponentiating the pooled
success rate hides heterogeneous task difficulty. Eight all-success trials do
not prove near-perfect reliability, and pass@k is not the success probability
of the candidate a real verifier actually selects.

**Experiment:** version both names/estimators in an offline report, retaining
historical semantics. Validate boundary cases and the worked example; report
trial count, task count, model/harness/dataset hashes and failed/error trials.
Use task-family clustered intervals for suite comparisons and keep clean trial
state; correlated retries cannot be presented as independent evidence. Never
relabel old projections or change routing thresholds silently. No evaluator
implementation is changed by this research report.

### Mechanism 2: outcome joins before outcome-weighted routing

Use an immutable chain from decision → attempt → produced patch → verifier →
protected merge identity → post-merge observation. Include candidate-set digest,
policy/model/harness versions, observed resource use, outcome time and source
coverage. Reuse the existing trajectory and learning-eligibility structures.
Missing, ambiguous or many-to-many joins remain ineligible, not repaired by
matching titles or nearest timestamps.

Keep two scorecards: prompt task verification for responsiveness and delayed
durability for quality. Pending, canceled, infrastructure failure, no patch,
verified failure, merged-unobserved and covered post-merge outcomes are distinct
states. Preserve the eval report's covered 72-hour horizon; absence of an error
is not a stability witness. Audit denominator completeness and censoring by
lane/task class. Treat heuristic follow-up attribution separately from a proven
revert of the exact merge commit; several agents can contribute to one result.

**Experiment:** join an authorized frozen ledger and PR export with explicit
coverage, including late adverse outcomes, duplicate imports, ambiguous merges
and failed source reads. Acceptance: exact attribution or explicit refusal,
idempotent replay, no success credit for unobserved merges, and no rates from
incomplete denominator sources. Keep `policyEligible:false` and
`recursiveLearningEligible:false` in the current projection; any successor must
prove its own evidence contract rather than flipping those flags.

### Mechanism 8: bounded learning and selective coordination

RouteLLM learns quality/cost choices from preference data; FrugalGPT explores
cascades; PILOT frames partial-feedback routing as a contextual bandit with a
budget policy. These motivate comparisons, not assumed savings for coding
fleets with shared subscription windows. [RouteLLM v4, 2025](https://arxiv.org/abs/2406.18665v4),
[FrugalGPT, 2023](https://arxiv.org/abs/2305.05176),
[PILOT, EMNLP 2025](https://aclanthology.org/2025.findings-emnlp.1301/).

Extend the existing offline routing experiment instead of building another RL
framework. Apply deterministic capability/quota/authority filtering first; learn
only among eligible actions using pre-decision task features. Optimize verified
success and covered durability alongside resource use and wall time, with
quality as a constraint. Included usage has opportunity cost but no invented
marginal dollar price. Costs must include planning, verification, retries and
coordination, not just the winning worker's inference.

Freeze policies and compare against current rank and a simple qualified-worker
baseline. Split by task family/repository/time, pin versions, report confidence
intervals and coverage, and use the existing off-policy diagnostic only where
true logged probabilities and action support exist. Deterministic histories
cannot identify unseen alternatives. A shadow recommendation is not a causal
estimate; pending durability cannot become a zero reward to accelerate learning.

For fan-out, compare one worker, independent read/review specialists and bounded
central synthesis at equal total compute. A 2026 scaling study finds task
structure and coordination overhead materially affect whether multiple agents
help; sequential dependencies can erase the benefit. This supports selective
parallelism, not a universal agent-count target.
[Kim et al., April 2026 revision](https://arxiv.org/html/2512.08296v3).

**Experiment:** reuse held-out tasks and the existing routing/TTC replay, adding
shared buckets, delayed feedback, provider/model drift and scarce workers.
Only evaluate fan-out where independent subclaims exist. Report quality,
p50/p95 completion, budget consumption, selected-candidate success and recovery
behavior. Proposed acceptance: lower 95% bound of quality difference above −1
percentage point, zero admission violations, and positive measured benefit
after coordination/verifier overhead. Insufficient power means inconclusive.
Any later randomized exploration needs separately established execution and
spending authority; this report starts none.

## Delivery sequence and evidence still needed

1. **Evidence fixtures first:** update dated provider-plan cases; reuse existing
   shared-pool and learning projections. Produce account-binding and coverage
   refusal reports before choosing a policy. Avoid new provider collectors when
   existing native metadata suffices.
2. **Pure replay next:** compare cadence, reset-fit and market policies using
   frozen/synthetic traces. Publish baseline, seed, dataset hash, event coverage,
   uncertainty and failed cases. Synthetic traces establish invariants, not
   production improvement.
3. **Observe through existing paths:** once separately implemented and verified,
   collect metadata-only timing and decision/outcome joins. No default policy
   changes; source availability must be distinguished from installed behavior.
4. **Adopt one proven delta at a time:** preserve current admission, route
   residency, claims, Stop, signed grants and Security pins. Dispatcher source
   changes require the existing Security review/re-pin before sanctioned install;
   this research performs no live installation.

Unavailable evidence: current enrolled provider balances and plan variants,
actual cross-surface billing identities, complete production queue timing,
source-qualified no-spillover execution bindings, and denominator-complete stable
outcomes with genuine selection propensities. The public survey cannot fill
those gaps. The most useful next artifact is a reproducible evidence-coverage
report against existing schemas, followed by the ranked offline experiments.
