# Session economics: batching, sub-agents and swarm sizing

RQ-SESSION-ECON-1 · checked 2026-11-14 · source baseline `96a5a9be22a`.
Research and advisory design only. Provider documentation establishes capabilities;
checked-in source establishes integration seams, not deployed behavior. Numerical
examples and proposed thresholds below are hypotheses, not fleet measurements.

## Decision

Treat a session as a reusable coordinator for related tasks. Preserve one claim,
worktree, acceptance result and PR per queue line. Choose **tasks per session**,
**concurrent children**, and **active root sessions** independently. Reuse context
while it saves more onboarding than it adds replay, coordination and rework cost.
Generate evidence-backed follow-up work as a separate session output; count value
when that work ships, rather than rewarding the number of READY lines emitted.

The task brief reports that a long-running session has remained useful. That is
qualitative evidence against mandatory per-task cold starts. It supplies neither
startup timings nor a controlled quality comparison, and cannot establish an
optimal task count or lifetime. Instrument first; do not encode an assumed optimum.

## What Phantom already has

[Batch sessions](../../contrib/mac/README.md#adaptive-concurrency-and-batching)
already combine 2–10 related lines, with an initial size target of 8 per lane.
[Configuration](../../contrib/mac/batch-sessions.json) names Claude, hosted Codex
lanes and Devin. [Planning and leases](../../contrib/mac/batch_sessions.py) retain
individual ownership; [the wrapper](../../contrib/mac/batch-launch.sh) prepares
each member's worktree before invoking host-owned `launch.sh`. The prompt asks
for one child per line; that does not prove tools exist or enforce concurrency.

[The batcher](../../contrib/mac/batcher.py) groups same-repo work by code area,
balances bundles, and caps combined prompts at 200,000 characters. It excludes
release, desktop, main-repair and PR-maintenance jobs. Dispatcher `member_ok`
also excludes lines carrying market constraints (`needs`, `exclusive`, `min_tier`,
`max_cost_class`); this design preserves that behavior until a separate change
proves equivalent admission for every member. Characters are not context tokens.

At reap, done/skipped members get individual publish handoffs; failed, deferred
and unreported members retry individually. A line gets at most two bundle attempts
before solo execution. Current tuning grows size by 1.25 at 85% done/skipped within
four hours, shrinks by 0.7 below 60%, on timeout or poorer measured throughput,
and bounds the target at 2–10. These are existing heuristics, not findings here.

[Phantom agent sessions](../SESSIONS.md) are a different abstraction: an event log
over queue turns, with profile/environment references. They do not provision a
provider conversation, keep a process warm, claim jobs or dispatch work. Retain
their identity as a possible parent link; do not treat `phm sessions resume` as
a provider resume adapter.

## Provider capability inventory

All sources below were opened on 2026-11-14. Documentation may describe newer
features than an enrolled binary. Record binary version, tool availability,
account policy and effective model before admitting a fan-out plan. Verify that
children can reach their assigned member worktrees within the existing sandbox.
Missing evidence means unknown; use sequential work or ordinary solo dispatch.

| Surface | Documented capability | Economic consequence and fleet pattern |
| --- | --- | --- |
| Claude Code sub-agents | Separate contexts, foreground/background work, custom tools/models and resumption. Ordinary children start fresh; forks inherit history. Current docs allow nesting, default depth 3, and describe a default concurrent spawn limit of 20 with exceptions for resumes/forks. | Use focused children for exploration or one member worktree each. Keep a fleet-wide child budget stricter than the provider ceiling; it is not a universal concurrency guarantee. [Claude sub-agents](https://code.claude.com/docs/en/sub-agents). |
| Claude Code agent teams | Separate cooperating sessions with shared tasks and peer messages; experimental, disabled by default. In-process teammates are not restored by resume/rewind. | Reserve for work whose peer coordination pays for separate session overhead. Do not assume sub-agent or team continuity from a resumed lead. [Claude teams](https://code.claude.com/docs/en/agent-teams). |
| Codex local CLI/app/IDE | Parallel sub-agents, follow-ups, result collection and custom agents; current clients enable tools by default, with delegation requested explicitly or through applicable project/skill instructions. Children inherit permissions; model/effort can be configured. `agents.max_concurrent_threads_per_session` caps spawned threads, excluding the primary; older `agents.max_threads` is an alias. | Request bounded fan-out explicitly. Keep broad investigation in children and return short findings. Tools/session limits in the enrolled runtime override documentation defaults. [OpenAI sub-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents). |
| Devin CLI sub-agents | Independent conversation chains; foreground waits, background continues and denies unapproved tools. Explore is read-only with a routed default model; general follows the parent's model. Prompt text cannot directly choose a child's model: a custom profile can. Default children cannot nest; custom profiles can opt in. Each child adds usage, including additional credits on prompt-based plans. | Send complete task packets; do not assume inherited history or that a requested model was honored. Use explore for research; general/custom for member edits. Unknown routed model means unknown child cost. [Devin sub-agents](https://docs.devin.ai/cli/subagents.md). |

The Claude source also explains that children incur their own usage. The Codex
source warns that fan-out increases token consumption; the Devin source's claim
of better cost/performance is vendor-reported, not a Phantom benchmark. A single
root with ten children can still make eleven agents' worth of requests.

| Provider continuation surface | Documented entry point | Adapter requirement |
| --- | --- | --- |
| Claude Code CLI | Saved conversations can resume by explicit ID with `claude --resume`; `--continue` selects a recent session. Non-interactive and running-background cases have distinct behavior. [Claude sessions](https://code.claude.com/docs/en/sessions). | Capture exact provider ID and bind it to lane, owner, repo and coordinator worktree. Validate unattended continuation for the installed version. |
| Codex CLI | `codex exec resume [SESSION_ID]` accepts a follow-up prompt; resume differs from forking history. [OpenAI developer commands](https://learn.chatgpt.com/docs/developer-commands). | Use an explicit ID, never fleet-wide `--last`. Preserve the lane's existing account/profile and sandbox. |
| Codex app server | `thread/start`, `thread/resume`, `thread/fork`, turn events and `thread/compact/start` expose lifecycle controls. [OpenAI app server](https://learn.chatgpt.com/docs/app-server). | Possible future structured transport; not evidence the present shell launcher uses it. |
| Devin CLI | `--resume <SESSION_ID>` selects a session, `--continue` selects the latest in a directory, and `--print` runs without a REPL. [Devin command reference](https://docs.devin.ai/cli/reference/commands). | Probe the supported non-interactive resume combination offline before adoption. CLI children do not establish Cloud session behavior. |

Cloud sessions, CLI children and desktop seats are distinct capacity/billing
surfaces. This inventory verifies CLI fan-out for all three providers; it does
not establish cloud child quotas, account entitlements or a universal child cap.
The checked-in model labels (including Devin's “free flash” label) are routing
configuration, not proof of current plan pricing or zero marginal quota use.

## A model that separates startup from useful work

Let `b` be tasks assigned over one root session's lifetime, `k` its maximum
concurrent children and `n` active roots on a lane. For a compatible candidate
set, measure the following quantities in their native units:

| Symbol | Meaning |
| --- | --- |
| `S` | Shared cold-start overhead: admission-to-ready process, checkout, dependency/tool initialization and common orientation. Split these phases; some remain per member. |
| `U_i`, `D_i` | Useful task service and incremental context/replay/compaction/coordination overhead for task `i`. |
| `H_i`, `R_i` | Child start/onboarding and expected recovery/rework, including correlated root failure. |
| `F(b)`, `I(τ)` | Waiting to fill a bundle and idle retention for time `τ`; include displaced urgent work. |
| `q_i`, `v_i` | Probability of an independently accepted result and its impact weight. Estimate by lane, repo, task class and session position. |
| `Q`, `M`, `W` | Provider usage vector, memory/disk peaks and wall/slot occupancy. Tokens, credits, ACUs and subscription quota stay distinct. |

Choose a feasible plan minimizing generalized cost per expected useful result:

```text
A(b,k,n,τ) = [ C_shared + Σ(C_useful_i + C_context_i + C_child_i + C_rework_i)
               + C_fill + C_idle + C_displaced ] / Σ(v_i × q_i)
```

`C_*` uses declared weights to convert elapsed time, quota and resource occupancy
into comparable opportunity cost. When weights or billing evidence are unknown,
report the vector/Pareto frontier rather than an invented dollar total. Existing
cash/credit budgets, quota and host caps are feasibility constraints. Subscription
capacity has opportunity cost even when an extra invoice dollar is zero. Generated
proposals have no realized value in the denominator until accepted work ships.

For serial equal-sized tasks, a useful toy model is:

```text
a(b) = S/b + u + ρ(b−1)/2
b_continuous = sqrt(2S/ρ), when ρ > 0
```

Assume equal quality, no fill delay, no children, and linear incremental context
cost `D_i = ρ(i−1)`. Compare neighboring integers and boundaries; if `ρ = 0`,
other constraints bound size. With hypothetical `S = 8 min`, `u = 12 min` and
`ρ = 0.4 min/task-position`, the existing 1–10 candidate range gives:

| Tasks/session | 1 | 4 | 6 | 8 | 10 |
| --- | --- | --- | --- | --- | --- |
| Modeled minutes/task | 20.00 | 14.60 | 14.33 | 14.40 | 14.60 |

The integer optimum is 6 under these assumptions. Lower startup or steeper
context penalty favors smaller batches. Similar performance across 6–8 cautions
against aggressive retuning on noise. Falling `q_i`, fill delay, heterogeneous
tasks and child costs invalidate this simplification; evaluate the full model.

Parallel makespan is approximately `S + critical_path(b,k) + coordinator_overhead`,
not `(S + ΣU_i)/k`. Every child still pays its own context and tool overhead.
Many worktrees still need individual preparation. Amortize only measured common
startup; never multiply the entire cold-start saving by the child count.

## Batching and context lifecycle

Prefer same-repo, same-area tasks sharing setup and facts. Admit each line under
its own scope budget and acceptance; retain independent branches and outcomes.
Sequential turns suit dependent facts or small edits whose child onboarding
would dominate. Parallel children suit independent investigations and independent
member worktrees. Recheck live claims, PR overlap and dependencies at assignment;
lexical similarity alone is insufficient. Do not batch urgent work behind a fill
timer. Compare observed fill time against saved startup before waiting for peers.

Start from the existing bounded batch machinery. A candidate policy may test
sizes 2, 4, 6, 8 and 10 against solo execution, without changing current defaults.
An eight-task bundle with `k = 2` is four waves, not eight simultaneous children.
Claim only work the bounded session can finish; a future rolling session claims
the next wave through the dispatcher when capacity opens, not from an agent
editing `ready.tsv` directly. Expired or abandoned claims return independently.

At each task boundary, checkpoint job/attempt IDs, base SHA, owned worktrees,
scope/acceptance, decisions with file references, verification, unresolved risks
and child states. Keep a bounded coordinator summary; store detailed evidence in
member artifacts. Reload changed instructions and source facts before another
task. A fresh child receives a compact task packet, not a transcript dump.

Use measured context pressure, replay tokens, repeated reads, compaction time,
test failures/rework and task-position quality to estimate context decay. Elapsed
hours alone do not measure rot. As experimental triggers, consider checkpointing
at 70% of a reported usable context window, and restarting after two consecutive
tasks exceed their matched cold baseline for overhead or rework. Both thresholds
need calibration; unknown context size is not zero pressure. Compaction keeps
the session identity but requires reloading acceptance and source evidence.

Claude's cost guide documents context management, cache reporting and background
usage as cost factors ([Claude costs](https://code.claude.com/docs/en/costs)).
Prompt cache, saved conversation, live process and warm environment are four
different states. The OpenAI API cache reuses matching prefixes; this is not a
promise about Codex subscription billing or a reason to keep an idle process
([OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)).

## Fan-out and swarm size

Select `k` as the minimum of independent ready work, runtime child capacity,
remaining lane request/quota budget, host resource headroom and coordinator
review capacity. Budget all descendants, not just direct children. Start an
experiment with 1–2 children; increase one step when useful throughput improves
and cost/result, tail latency and rework remain acceptable. This is a proposed
starting policy, not a statement about provider maxima or current configuration.

Use three patterns: a root executing related tasks serially; a root farming
independent tasks to bounded children; or a root using read-only scout/reviewer
children around one writer. Read-only roles require effective tool restrictions,
not just prose. Same-branch writers serialize. The root validates each member's
artifact and checklist, rather than accepting a child's completion claim alone.

Account for `n` roots plus their children and tools/tests. Parent slot accounting
alone can conceal a request or RAM surge. When child fan-out increases, reduce
admissible new roots if necessary; never raise the global cap implicitly. A rough
planning bound is `n × (m_root + k × m_child) + m_tests <= available_memory`,
alongside provider request and quota constraints. Use measured peaks and safety
headroom; shared caches make additive RSS only an approximation. If an experiment
measures 12 child permits and chooses `k = 2`, it admits at most six such roots,
also bounded by ordinary lane/host caps. Do not reserve permits for queued waves.

Prefer fresh child contexts for unrelated details and retained roots for shared
decisions. Nested fan-out remains off in the proposed baseline even if a provider
allows it, until descendant usage can be accounted for. Slow or failed children
must not block successful members from eventual individual reap. Current batch
reap occurs at root finish; incremental member handoff would be a separate change
requiring idempotent outcomes and proof that no writer still holds the worktree.

## Warm retention versus cold spawn

Decide independently whether to retain conversation metadata, keep an environment
ready, and hold a process. A saved transcript can outlive a released process.
Retaining a warm root is worthwhile only when:

```text
p(compatible arrival within τ) × (cold_start − resume_cost + reusable_context_value)
  > idle_resource_cost(τ) + displaced_work_cost(τ) + expected_staleness/rework_cost(τ)
```

All terms use the same declared opportunity-cost units. Estimate arrivals by
repo/area/lane and eligibility, rather than the fleet's total queue rate. Compare
TTL candidates 0, 5, 15 and 30 minutes in shadow; do not send model keepalive
prompts. Provider idle charges and cache lifetime remain unknown unless the
enrolled surface reports them. Release compute permits only after child activity
is confirmed stopped; close finished threads when provider limits count open
threads. A retained process counts toward memory/process occupancy until exit.

| Evidence at the task boundary | Proposed action |
| --- | --- |
| Compatible admitted work, healthy context and available permits | Continue the root; bind a fresh per-task claim and bounded children. |
| No eligible work, reuse value exceeds idle cost, host has headroom | Retain briefly with an expiry and no model polling. Recheck admission on reuse. |
| Process lost but exact session ID and useful checkpoint exist | Resume with fresh process/admission checks; measure replay and environment setup separately. |
| Unrelated repo/owner, stale permissions/instructions, high replay/rework, unavailable resume | Checkpoint and cold-start the next independently admitted task. Preserve existing edits. |
| KILL, lane hold, quota exhaustion or host pressure | Admit no more work; follow existing stop/reap semantics and retire idle capacity. |

`resume` must confirm the expected provider identity and a completed turn; exit
code alone is insufficient. On ambiguous transport failure, reconcile before
retrying. A fallback cold spawn receives a new attempt identity and cannot run
alongside an unresolved old writer. Never reuse another owner's conversation,
move auth between lanes or restore a more permissive historical tool policy.

## Swarm mode: consume work and produce evidence-backed work

A swarm session has two outputs: completed queue members and a bounded candidate
digest. Discovery is part of the task boundary, not an unlimited self-assigned
mission. Candidate discovery can use test failures, adjacent defects, repeated
operator friction or cited research. Each candidate records parent job/attempt,
evidence, target paths, impact, effort, confidence, dependency and acceptance.
Zero candidates is a valid outcome. Finish owned work before spending a proposed
maximum 10% of active time on discovery; cap a session at three candidates in the
initial experiment. Do not pay for separate discovery children by default.

Reuse [the research loop](../RESEARCH-LOOP.md) and
[proposal implementation](../../src/core/research/proposals.ts): its existing
`## S<n>` source sections and `## Proposals` bullets produce scored, linted
`- READY` lines in a dry-run report. The worker writes only a local candidate
artifact and copies rendered lines into its handoff. It cannot mutate queue
state or claim the work it just invented. The scheduler/intake stage later
deduplicates against current queue, live claims, open PRs and shipped work,
validates scope/tier/capability/cost/dependencies, and admits through the normal
queue writer. Existing digest dedup covers queue/shipped corpora and within-run
overlap; fresh live-claim/open-PR checks and durable lineage are proposed additions.

For example, a root completing `RQ-A` hands off member verification plus an
archived `candidates.md` and dry-run `candidate-plan.json`. The latter contains
zero to three rendered READY lines, their provenance and lint verdicts, alongside
`parent_job=RQ-A`, the attempt and a scope fingerprint. Intake can accept one and
drop two without changing `RQ-A`'s result. This sidecar/lineage contract is
proposed; the existing digest command supplies only its documented plan fields.

Archive the artifact before member/root worktrees are reaped. Identify candidates
by normalized scope/evidence fingerprint plus stable ID; do not mint a different
job on every retry. A proposed admission receipt links parent, candidate digest,
score, dedup/admission decisions and eventual task ID. Record rejected candidates
with reasons. A replay must not append a second READY line. Candidate provenance
never grants authority, quota, an exclusive claim or a new cost class.

Avoid a work-generation feedback loop: the initial experiment permits one
generation of descendants per seed; further findings remain candidate artifacts
for the next planning pass. Let `c` be candidates per completed task, `a` the
admitted fraction and `d` their completion probability. The reproduction proxy
`R = c × a × d` warns of sustained branching at or above 1; it does not prove
quality or queue stability. Track arrival/service rates separately. Throttle
generation on stale/duplicate evidence, growing queue age, merge/review congestion
or weak downstream yield. Current queue depth/backpressure still bounds intake.

Credit a candidate only once when its independently accepted change ships; keep
producer attribution separate from executor output. Report candidate admission,
merge yield and impact beside generation overhead. A hundred duplicate READY
lines are cost, not progress. Holds, dependency gates, Security pin boundaries,
outside-send rules and existing spending limits apply to generated work too.

## Concrete source integration points

The following is a proposed implementation map. This change edits none of these
components and enables no runtime behavior.

| Source seam | Existing behavior | Proposed source-only follow-up |
| --- | --- | --- |
| [dispatchd.py](../../contrib/mac/dispatchd.py): `member_ok`, `form_batch`, claim/spawn block | Eligibility checks, batch membership, per-line leases, root launch and lane/global caps. | Compute advisory `(b,k,n,retain/resume/cold)` after existing admission; record alternatives and reason codes. A future warm assignment still claims under dispatcher ownership and route hysteresis. |
| [batcher.py](../../contrib/mac/batcher.py): `pick_members`, `size_for`, `tune`, `throughput` | Prompt-bounded grouping and completion/throughput-based tuning. | Compare batch size independently from fan-out and session age; include per-member latency, quality and provider usage. Report unknown evidence instead of increasing size on missing samples. |
| [batch_sessions.py](../../contrib/mac/batch_sessions.py): `render`, `model_for`, `northstar` | One child per line, model hints and root/task metrics. | Render wave/child limits, exact task packets, checkpoint and candidate-artifact paths; record effective models separately from requested models. Keep skips separate from useful completions. |
| [batch-launch.sh](../../contrib/mac/batch-launch.sh) | Member worktree preparation then host `launch.sh`. | Timestamp shared/member setup, persist provider/root/member identity mapping and validate runtime capabilities before fan-out. Do not repurpose a member worktree as a shared writer directory. |
| [launch candidate](../../contrib/mac/host-integration/launch.candidate.sh) and [host boundary](../../contrib/mac/README.md) | Source snapshot invokes provider CLI processes; deployed `launch.sh` is host-owned. | Candidate adapter for explicit-ID resume, turn completion, checkpoints and bounded idle expiry. Preserve existing scrubber, environment allowlist, lane sandbox/account and exit receipts. A source snapshot is not the deployed launch contract. |
| [dispatchd.py](../../contrib/mac/dispatchd.py): `reap_batch`, `handoff_member`, `release_batch` | Per-line outcomes, ownership-aware release/retry, idempotent handled markers. | Archive economics/candidate receipts and reconcile children before cleanup. Warm roots need a turn/member lifecycle distinct from root process exit; retain current root-finish reap until proven. |
| [research proposals](../../src/core/research/proposals.ts), [digest CLI](../../src/cli/fleet-research-digest.ts), [restock.py](../../contrib/mac/restock.py) | Provenance/scoring/dedup/lint, explicit apply, locked queue writes, dependency and backpressure handling. | Consume archived swarm artifacts through existing intake; add fresh claim/PR overlap and lineage before normal admission. Never append raw agent output directly to `ready.tsv`. |

Proposed advisory receipts use schema `session-econ.v1`, with session, turn,
attempt, batch/member and provider-child IDs; lane/repo/base SHA; capability
version; chosen/alternative `b,k,n`; context and usage evidence; retention expiry;
decision/reason and evidence timestamps. Candidate receipts add parent/fingerprint
and intake disposition. IDs and counts only; no prompts, transcripts or secrets.
These fields and reason codes are a proposal, not a supported command/schema.

Implement first as pure planning plus offline fixtures, then shadow observation.
Fixtures should cover wrong resume IDs, root death with partial member outcomes,
child quota exhaustion, stale/unknown usage, duplicate candidate replay, live-PR
overlap and invalid scopes. Each case must preserve per-task ownership and avoid
a second writer or duplicate READY admission.
Any later runtime wiring requires the applicable Security review/re-pin before
host installation. Do not install a candidate over live pinned machinery, edit
host launchers, change sandbox/auth boundaries or activate paid provider capacity
as part of this strategy work.

## Measurement and rollout criteria

Join events by attempt and session turn, not job ID alone. Measure enqueue,
claim, checkout/dependencies complete, provider ready, first useful action,
child start/stop, member accepted, root idle/resume/exit, publish and merge.
Existing `launch`, `finish`, `task_outcome` and northstar rows give only part of
that sequence. Missing or ambiguous boundaries remain unmeasured. Attribute
shared setup once; child usage once; bundle-member reap rows are not extra roots.
Report root-slot hours and summed agent-active hours separately from wall time.

Primary metrics are independently accepted tasks and impact-weighted stable
merged changes per wall hour and per native quota unit. Also report startup
fraction, tasks/root, child utilization, p50/p95 enqueue-to-member-result,
replay/cache/compaction overhead, failures/timeouts, duplicate/skip rate, rework,
retained idle occupancy and generation-to-merge yield. Existing done/skipped
tuning is not a quality metric. Require observed post-merge evidence for the
stability label; mark immature/unobserved outcomes separately.

Compare matched repo/area/tier/task-size cohorts: cold solo, serial batches,
wave fan-out and explicit-ID resume. Vary one dimension at a time; stratify by
provider surface/model/version and quota reset window. Randomize at root-session
level because children share failures; include failed, timed-out and unfinished
sessions in denominators, with censoring reported. Use a common arrival trace
for shadow replay; do not consume new paid capacity to run this research.

As a proposed pilot floor, collect at least 30 root sessions per arm, report
uncertainty and increase the sample if intervals remain wide. Promote only when
useful throughput improves, cost/useful result does not worsen, quality remains
within a declared margin and p95 latency stays within its declared service bound.
Choose margins before observing results. Missing evidence or a noisy tie keeps
the current policy. Existing lane/host caps and holds always take precedence.
If a later experiment underperforms, stop new assignments under that experiment
and drain/reconcile owned tasks through the existing lifecycle; preserve work.

The first implementation should therefore instrument shared startup and child
usage, compare bounded waves within existing bundles, and only then consider
rolling warm sessions and automated candidate intake. That sequence makes the
economics observable without mistaking session longevity or queue growth for
useful shipped work.
