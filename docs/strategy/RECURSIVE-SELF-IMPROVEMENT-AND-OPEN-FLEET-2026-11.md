# Recursive self-improvement and the open Phantom fleet

Chasing open-source RSI (recursive self-improvement) is Phantom's mission.

November 17, 2026 · Strategy proposal, not a description of a live service.

**Decision:** Close the improvement loop on Phantom's own public work before
opening execution to outside nodes. Build a fully open-source, recursively
self-improving, autonomous software factory that owns its maintenance,
improvement and day-to-day use. Anyone should be able to contribute agents or
compute, including eligible capacity from their own subscriptions or credits.
Think SpaceX/Tesla-scale directional alignment: one mission and evidence
standard, many autonomous teams and machines. Pool work and available capacity,
not accounts, credentials, private context or authority. Here, recursion means
improving the software, prompts, routing and skills that produce the next
round of improvements; it does not require training foundation-model weights.

## What the a16z interview actually says

[OpenAI’s Cofounder & Research Chief Explain Self-Improving AI](https://www.youtube.com/watch?v=h_aA1-R70E8)
is the Nov. 17, 2026 a16z *Working Theory* debut. Host Sarah Wang interviews
Mark Chen (OpenAI chief research officer) and John Schulman (Thinking Machines
Lab co-founder and chief scientist, and an OpenAI co-founder).
[Podcast show notes](https://podfollow.com/a16z-podcast/episode/9a8910bac6926f2e2c482e7eafbfa3d249f6ec29/view)
use the alternate title *Can AI Learn to Improve Itself? | Recursive
Self-Improvement*. The YouTube title and available transcript excerpt were
checked directly; the date and chapter starts were cross-checked against the
[video description mirror](https://zolotube.com/watch?v=h_aA1-R70E8).
The excerpt cuts off in the evaluation discussion. The later sections below
use a [detailed secondary summary](https://finance.biggo.com/podcast/66a27b08edb683e8)
and linked research; exact wording and within-chapter timings there are
**UNVERIFIED**. A standalone a16z.com page for this episode was not found.

| Leverage | Interview mechanism and evidence | Phantom gap and response |
| --- | --- | --- |
| 1. Verify the gain | [01:58](https://www.youtube.com/watch?v=h_aA1-R70E8&t=118s), [05:56](https://www.youtube.com/watch?v=h_aA1-R70E8&t=356s): AI assists both mainline training and small exploratory runs; Chen wants a shift against the counterfactual. Pretraining has a tractable proxy (perplexity); downstream evals expire as models improve, and the secondary summary describes automating the creation of harder evals. | Deterministic PR metrics, pass^k and live outcomes are separate signals. Bind them to an exact candidate, keep rotating held-out tasks and compare with an unchanged live control. Don't substitute one benchmark or merge volume for usefulness. |
| 2. Train proposal judgment from outcomes | [03:21](https://www.youtube.com/watch?v=h_aA1-R70E8&t=201s), [05:56](https://www.youtube.com/watch?v=h_aA1-R70E8&t=356s): scoped “research interns” can implement, run, monitor and report on a specified experiment. In Schulman's example, expert redirection gets further than a long autonomous run. He discusses feedback on idea quality and learning from predictions that turn out wrong; researcher ratings for RL are a suggestion, not a demonstrated solution. | Give every experiment a falsifiable hypothesis, one change, a budget and a stop rule. Record losing as well as winning bets. Learn which proposals transfer across tasks, and compare the learned proposer with deterministic rules instead of optimizing trivial knobs. |
| 3. Make oversight independent | [10:57](https://www.youtube.com/watch?v=h_aA1-R70E8&t=657s), per the secondary summary: Chen discusses model-behavior monitoring, goal drift and stronger models helping align others. Schulman discusses separately rewarding honest self-reports, as in [OpenAI's confessions research](https://openai.com/index/how-confessions-can-keep-language-models-honest/). [Anthropic's study](https://www.anthropic.com/research/automated-researchers-mitigate-alignment-failures) is evidence on characterized alignment failures, not a guarantee for unconstrained agents. | Let separate agents propose safety tests and diagnose refusals, but evaluate with a verifier outside the producer's control. Use evidence-linked incident reports and tool/policy receipts, not private reasoning traces or self-reported passes. Keep the evaluator and authority rules outside candidate write scope. |
| 4. Use scarce compute where it transfers | [03:21](https://www.youtube.com/watch?v=h_aA1-R70E8&t=201s), [05:56](https://www.youtube.com/watch?v=h_aA1-R70E8&t=356s): Chen measures scoped automation partly by experiment compute managed through Codex. The secondary summary describes the need for small runs that predict larger runs when compute is scarce. | Use replay and inexpensive lanes first; reserve repeated frontier and cross-node trials for candidates likely to affect real outcomes. Measure predictive validity of small runs rather than assuming it. More node-hours are not evidence of improvement. |
| 5. Publish the direction, not all the data | [15:08](https://www.youtube.com/watch?v=h_aA1-R70E8&t=908s) closing chapter; the secondary summary attributes to Schulman the case for public alignment research and customizable values. | Publish shared missions, protocols and evidence requirements. Scope policy and capacity choices to owners; no outside node gets access to another tenant because it agrees with the common mission. |

Chen's percentages are judgments on his own spectrum, not objective progress
measurements. [METR's assessment of Anthropic](https://metr.org/blog/2026-11-05-anthropic-ai-rd-acceleration-assessment/)
and [OpenAI's internal account](https://openai.com/index/research-acceleration-view-inside-openai/)
are distinct evidence about research acceleration, not proof that models
independently invent and build their own successors. The interview's future
curve and compute forecasts are **UNVERIFIED** as outcomes.

## What Phantom has today

| Surface | Existing behavior and limit |
| --- | --- |
| [Steward and improvement](../architecture/context-and-self-improvement.md#4-self-improvement-loop) | `phm steward` defaults to disk/log reporting; over-quota roots, declined handoffs and tagged feedback feed `phm improve` alongside other learning surfaces. Drafts have declared metrics; the digest-chained outcome ledger ranks by realized leverage. Promotion re-measures the deterministic metric on exact merge base and head, checks diff restrictions and can queue eligible exact-head PRs. It does not treat a live A/B result as that deterministic metric. |
| [pass^k](../EVAL-PASSK.md) | Pinned golden tasks, clean worktrees and per-task/lane-model reports; pass@1 measures a single attempt, pass@k at least one success and pass^k all-k consistency. The advisory lane projection and regression journal do not activate policy. A missing comparison is not a pass. |
| [Learned skills](../SKILLS.md) | `learnFromApplied` writes scrubbed metadata-only cards after verified merges survive observation. The existing [lesson holdout](../../src/core/improve/lesson-trial.ts) measures the effect of injecting approved lessons; writing a card does not establish its effect. Nightly retro proposals and advisory routing priors are not active policy. |
| [Daemon](../daemon-tick-phases.md) and [routing](../QUEUE.md) | The daemon bounds phases, records degraded/timeouts and runs reflection off-tick in the resident loop. The work market filters by capabilities, clearance, cost and tier before ranking; outcome learning already tracks routing cells. Lane hints aren't grants and the Mac dispatch candidate is not permission to install or re-pin live. |
| [Node router](../NODE-ROUTER.md) | Caps, heartbeats, local auth, owner filtering, leases and fencing are useful foundations. The local store is not an ACL boundary. The [multi-Mac pool](../../AGENTS.md#multi-mac-node-pool) uses trusted SSH peers and primary/backup fencing; it is not a multi-tenant public service. Fencing prevents stale acceptance, not duplicate effects at sinks that ignore the fence. |
| [Constitution](../../CONSTITUTION.md) | Article 1 allows autonomous ordinary merges and sanctioned releases; Security GATES v3, existing holds, fork-only publishing and the prohibition on making private material public remain. Article 9 says fix merged code forward, not auto-revert. The Constitution has a distinct narrower promotion path for loop-owned self-improvement PRs. |

## The proposed recursive loop

**Observe → hypothesize → test against control → shadow/canary → expand or
contain → observe again.** Run it on a bounded portion of the enrolled public
backlog first, including maintenance of the loop itself. Give each project
an outcome target, accountable role and budget under a shared public mission.
Assign one writer per candidate and use the shared work market for execution.

1. **Observe.** Consume pass^k alerts, verified merges and subsequent CI,
   fix-forward and incident evidence, lesson holdouts, routing receipts
   (`work-market.v1`), queue age, retries, provider throttling, steward and
   daemon health, and explicitly tagged feedback. Join on task/attempt, exact
   head and policy revision. Deduplicate, classify data before ingest, record
   sampling windows and distinguish pending, missing and failed. Do not
   forward logs, private links or raw prompts to a model or public ledger.
2. **Propose.** Before running anything, register the target, evidence refs,
   change size, predicted delta, minimum detectable effect, cohorts, resource
   ceiling and stop rule. Start with deterministic proposal generation; let a
   separate scoped agent propose or critique alternatives. Rank by expected
   durable impact, transfer, uncertainty and cost, with a capped exploration
   budget for unproven ideas. Keep failed and inconclusive experiments so the
   next cycle learns what not to retry. One experiment per policy surface and
   cohort at a time; no candidate can expand its own budget, clearance or tools.
3. **Gate on two kinds of evidence.** Independently replay the same task
   snapshots against base and candidate in clean sandboxes, pinning dataset
   digest, evaluator build, model/lane and policy digests. Compare matched
   trials with task-blocked intervals, fixed sample sizes and comparable
   provider/time blocks. Use pass^k and absolute per-slice floors plus
   tests/diff/instruction guardrails; require a declared improvement or
   noninferiority bound, not just absence of an alert. Rotate withheld
   failure-derived cases under a separate verifier, retain a stable
   longitudinal set, and keep exploratory and confirmation sets separate.
   New evals must distinguish known-good from known-bad and cannot score
   the experiment that created them. Inconclusive, starved or missing
   cohorts stay at their current allocation. For a self-improvement PR,
   retain the exact-head deterministic remeasurement and existing merge
   path; stochastic results inform candidate selection and runtime
   activation, not a new mandatory repo-wide check or human queue.
4. **Shadow, canary, expand.** Replay without dispatch, then assign a stable
   randomized 5% canary of eligible public tasks by task ID, stratified by
   task class and provider, with the current policy as control. Increase to
   25%, then 100% of eligible non-holdout work only after the prior cohort
   meets a predeclared sample floor and completes observation (initial
   window: seven days after merge); retain a 10% control. Measure durable
   verified completions per eligible assignment and per worker-hour,
   assignment-to-verified-completion p95, resource units per durable
   completion, and incident, retry and fix-forward rates. Publish
   denominators, unresolved outcomes and stratified estimates; do not
   reward picking only easy tasks, faster weak patches or repeated fixes.
   For early low volume, run longer or stay at shadow/canary, not looser.
5. **Contain, then fix forward.** On an isolation/policy violation, Stop,
   expired evidence, or a breached guardrail, freeze expansion and stop new
   candidate allocations. Close the experiment, expire or fence claims as
   needed and route eligible new work to the unchanged control (runtime
   rollback of experimental exposure only). Record why, identify affected
   cohorts and keep the evidence. If code has merged, repair with a new
   commit and ship through the existing qualified release path; never revert
   main automatically, rewrite history or downgrade a release. A failed
   control or security incident pauses affected dispatch, not just the candidate.

| Recursive target | What changes in the next round |
| --- | --- |
| Prompts | Version a task-scoped prompt fragment and compare one edit at a time with the pinned template. Learn from verified instruction adherence and durable completion; never let prompts grant permissions. Pinned leader prompts stay outside the loop unless handled under Security GATES. |
| Routing | Fit bounded weights or priors from matched assignment-to-outcome pairs, accounting for pending/censored work. Run in shadow, then blend into ranking with a capped delta and a small exploration share. Eligibility, local-only jobs, budgets, hysteresis and postures remain policy; weights cannot override them. |
| Skills | Propose a revision from multiple independent verified outcomes. Reuse skill attestation and the lesson-holdout design; inject only a scrubbed, scoped card, keep a no-skill control and retire a card that doesn't transfer or whose evidence expires. Untrusted results may nominate a card, never activate one. |
| The loop itself | Trial the proposer and eval refresh strategy like any other candidate, against a frozen external evaluator and rules-based proposer. Publish prediction error, experiment yield and negative results. Do not let the loop alter its own gate, benchmark for the current run, credentials, or governance. |

### Proposed interfaces

Extend `src/core/improve/` with `experiments.ts` and `activation.ts`;
consume the existing `eval/passk.ts` report rather than introduce a second
scorer. Project read-only routing evidence from
`src/core/routing/outcome-learning.ts` and map skills to revisions from
`src/core/fleet/skill-library.ts`. Use the daemon's single-flight off-tick
pattern to enqueue evaluation and observation; keep only bounded snapshot
and activation work on-tick. Separate the candidate writer, evaluator and
activation writer. Publish an atomic pointer to the active policy digest
under `$ASHLR_HOME/improve/`; append idempotent transitions in a separate
digest-chained experiment journal. Missing, corrupt or unknown-version
evidence prevents activation, never authorizes it.

Proposed CLI only (not installed today): `phm improve experiment plan --json`
and `phm improve experiment status --json` are read-only;
`phm improve experiment advance <id> --apply --json` is a guarded transition
that revalidates receipts and respects Stop/Pause. The daemon uses the same
guard, not shell wrappers around the CLI. Example private projection:

```json
{
  "schema": "improve.experiment.v1",
  "id": "exp-route-014",
  "ownerScope": "phantom-public",
  "dataClass": "public",
  "kind": "routing",
  "state": "canary",
  "base": {"headSha": "<base sha>", "policyDigest": "<sha256>"},
  "candidate": {"headSha": "<head sha>", "policyDigest": "<sha256>"},
  "eval": {"datasetDigest": "<sha256>", "verifierDigest": "<sha256>", "reportId": "<passk report>"},
  "metric": {"name": "durable-completions-per-assignment", "direction": "increase", "predictedDelta": 0.03},
  "allocation": {"candidatePermille": 50, "holdoutPermille": 100, "minCompletedPerArm": 40},
  "outcome": {"observedDelta": null, "reason": "window-open"}
}
```

Acceptance tests belong with the experiment and routing suites: stale head or
dataset, candidate-authored verdict, replayed transition, underpowered canary
and Stop must never advance exposure. Test a real improvement through the
full state machine with hermetic fixtures before a live activation.

## Open contributor fleet: public work, local custody

**Use a separate public coordinator and queue rather than exposing the private
node store or trusted SSH endpoint.** Put a narrow pull broker beside
`src/core/drive/nodes/` (proposed `contributor-broker.ts` and
`contribution-ledger.ts`); reuse lease/fencing and capability semantics, not
the local store or its trust assumptions. Workers make outbound authenticated
connections. Enrollment binds a short-lived, revocable grant to a contributor
principal, node key, owner scope, capabilities, job limit and maximum data
class. The server derives eligibility from grants, not worker-provided owner or
capability strings. Authenticate and authorize each list, claim, renew and
completion; never return another scope's node inventory. Drop leases on
revocation and require current epochs and fences at every effect sink.
Connection and auth failures back off; they never fall back to a private lane.

| Tier | Permitted contribution | Data and authority |
| --- | --- | --- |
| Guest | Local smoke job or bounded public fixture/replay | Synthetic or explicitly `public`; no publication or privileged judging. |
| Verified community | Public builds, benchmarks and candidate patches after reproducible accepted work | Explicitly `public` only, still untrusted output. No private repos, shared shells, deploy keys, merge ability or protected held-out corpus. |
| Enrolled team / owner-operated | Separately enrolled team work and independent verification | Only that owner's permitted classes. `internal` stays within its reviewed owner boundary; `confidential` and `restricted` stay on specifically authorized owner infrastructure, never the public broker. |

Classify the entire job, including prompt, commit, dependencies, artifact
destinations, cache and provider eligibility; unclassified fails closed on
the public path. A public repo does not make an incident, prompt or eval
dataset public. Keep private repositories and their existence where sensitive,
private telemetry, raw logs, owner identities, private workloads, holds
enforcement internals, credentials and even private secret handle names out of
community jobs and exports. Separate cache/storage namespaces and sanitize
artifacts before accepting or publishing. No on-demand declassification by
agents. Escalate uncertain rights or visibility rather than copy it.

**Bring your own compute.** Let contributors opt in to a local model,
permitted subscription capacity or their own metered credits, with explicit
limits, pause/leave and a circuit breaker on quota/renewal. Sign in to the
provider locally; the agent job sandbox has no auth files, host mounts or
general network. A local provider adapter may make scoped inference calls on
its behalf only where terms expressly allow this use; it does not export
auth or hand it to the agent. Report capability, permitted capacity and
availability, never account secrets, balances or profiles. Default to local
or included capacity; paid capacity requires the contributor's explicit
budget and provider terms, never central money, billing changes, account
sharing, quota circumvention or silent paid fallback.

**Treat both the pack and result as hostile.** A worker is protecting its
machine from jobs, and the coordinator is protecting the project from
workers. Use signed allowlisted pack manifests with exact public commit and
artifact digests, fixed entry points, ephemeral VM or equivalent isolated
runner, resource limits, no arbitrary privileged shell, an empty HOME and
default-deny egress. A separate broker adapter handles network and credentials.
If isolation can't be enforced, refuse the job. An untrusted host can inspect
anything it receives and can forge output regardless of sandboxing. Accept
bounded artifacts as inert data; validate and replay patches and outcomes in
separate trusted, secret-free sandboxes. Use independently allocated
replicas or trusted spot checks for claimed compute results. Workers cannot
publish, merge or deploy on behalf of an owner, and no offensive jobs or
unapproved external effects are in the catalog.

**Account for useful work, not advertised capacity.** Issue a signed receipt
after trusted acceptance, once per job/effect and fence. Show offered
capacity separately from verified work. Credit verified public task units
(fixed by job class), valid eval replications and durable patch outcomes;
cap credit for retries, replicas and subdivided tasks. Offer opt-in public
attribution and non-monetary credits, not transferable tokens, payouts,
priority buying or permission escalation. Rate-limit signups and outstanding
claims per principal and global pool; bind nodes to principals, cap linked
identities and use randomized audits. Detect duplicate artifacts, impossible
timings and colluding replicas; quarantine and revoke on bad evidence, with
an appeal path and minimal retention. Identity proofs raise abuse costs but
do not prove uniqueness. Don't let a popularity vote or leaderboard choose
accepted evidence.

Proposed CLI only: `phm node contributor join --json` enrolls against the
public broker; `phm node contributor status --json` shows own scope, limits
and liveness; `phm node contributor leave --json` revokes the local session.
Example accepted receipt (not raw heartbeat or provider usage):

```json
{
  "schema": "fleet.contribution.v1",
  "ownerScope": "phantom-public",
  "principalId": "<pseudonymous id>",
  "jobId": "<id>",
  "fence": 42,
  "artifactDigest": "<sha256>",
  "verificationReceipt": "<trusted replay id>",
  "result": "accepted",
  "creditUnits": 1
}
```

**Governance.** A public roadmap gives the fleet direction; agents rank and
execute scoped work and publish aggregate evidence. Outside changes arrive as
fork proposals and go through normal GitHub protections and the existing
fork-only publication process. Independent agents verify exact heads without
exposing base credentials to forks. Community nodes get no merge credential;
authorized maintainer agents use normal affected-only checks and the merge
queue where required, with scheduled full CI and sanctioned releases from
qualified SHAs. Do not treat a fork as a loop-owned self-promotion PR:
`phm improve promote` refuses forks. Never use admin bypass, new billing,
unauthorized sends, force pushes to the default branch or exceptions to holds.
Security GATES v3 pins and review for the secret gate/publication wrapper,
sandbox and leader boundary, secret-leaking workflow diffs, and MACCU TCC
helper and loopback auth remain intact. Adding capacity is not authority to
change these protections. Public contribution guidelines and incident
reporting describe the boundary without publishing private operational data.

## Launch in phases

| Phase | Scope and exit evidence | Main risks |
| --- | --- | --- |
| 0. Open-source inventory and loop baseline | [GitHub metadata](https://api.github.com/repos/ashlrai/phantom) identifies the source repo as public and MIT; the [published npm package](https://www.npmjs.com/package/@ashlr/phantom), [license](../../LICENSE), [contribution guide](../../CONTRIBUTING.md), docs, golden fixtures and router sources are starting assets, not a public worker service. Check dependencies, assets, datasets, generated bundles and history for rights and private material. Keep MIT for Phantom source/docs; record third-party terms and attribution rather than assuming rights to vendor tools, models or data. Publish only reviewed open components, not private services, repositories or credentials; private inventory is **UNVERIFIED** from public metadata. Exit: reproducible secret-free public build, baseline experiment and clear contribution/security instructions. | License drift, accidental disclosure, assuming public code equals open operations. |
| 1. Dogfood on enrolled machines | Run report-only, then one bounded public maintenance experiment on trusted nodes. Exercise the existing lease and Stop/Pause paths, verify exact-base/head evidence, simulate low volume and provider failure, and demonstrate canary containment without a code revert. Exit: a complete auditable loop, including a rejected or inconclusive candidate and an explainable credit receipt. | Self-scoring, metric gaming, delayed outcomes, eval overfit and excess compute. |
| 2. Opt-in Dev Shack pilot | Likely first community: Dev Shack Discord, around 500 members, started by engineer Alex around Weyv, with 15k+ downloads reported for Weyv. These are owner-provided figures, **UNVERIFIED** independently. Prepare a pinned start-here guide (not a post in this task): purpose, local-first rules, terms, what telemetry leaves the Mac, one fixture, public starter issues, support and private security-reporting paths. Use Discord for education/help, never identity, secrets, execution, consent to spend or merge authorization. Exit: independent first-job completions, successful isolation/revocation and scope tests, and audited receipts under a capped cohort. | Social engineering, operator support load, provider terms, unsafe onboarding shortcuts. |
| 3. Public capacity and governance | After pilot evidence, open enrollment gradually for public jobs only. Publish protocol and self-hosting instructions, test fixtures, status, roadmap, evaluation methodology, aggregate completion/incident/credit data and how to contest receipts. Add more owners independently, not by loosening the public tier. Exit: real durable improvement across multiple cycles versus control, predictable costs and no cross-owner leaks in tests or operation. | Sybil credit gaming, correlated model failures, coordinator outages, dominance by a few suppliers and mission drift. |

### Join your Mac in 60 seconds

**Available now, local only:** with Node 22.15+ installed, use
[Add a computer in 60 seconds](../add-a-computer.md) to install Phantom and
join/heartbeat/enqueue/pull/complete/leave a temporary local scope. Use
build-only caps, no GitHub login, a harmless public fixture and a scratch
Phantom home. This verifies local registration and one fenced lease
end to end; it doesn't join a community network or start a worker.

**Pilot path after the broker ships:** from the published, version-pinned
install guide, verify the package and coordinator, enroll a node key into a
public-only scope, choose local compute or an allowed provider with a hard
local budget, run one signed smoke fixture, and check liveness and the
verification receipt. Provide a prominent leave command and show what stops
and what receipt data remains. Target 60 seconds from prerequisites to the
first claim, not from a fresh Mac or including provider login. Keep
`CONTRIBUTING.md` as the canonical development entry point; add this path and
provider-policy/privacy disclosures there when the service exists.
