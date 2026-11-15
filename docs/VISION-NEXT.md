# Vision next: ten moves toward a self-improving engineering entity

This is a ranked planning handoff for **RQ-PLAN-VISION-NEXT**, written
2026-11-08. It is not runtime activation guidance and does not claim any move
has shipped. The [move manifest](plans/vision-next.json) is canonical: stable
IDs, ranks, dependencies, acceptance criteria, validation and authority
boundaries. No jobs were enqueued by this change. The top three moves have
implementable specs:

1. [Attempt identity](plans/VISION-NEXT-SPEC-ATTEMPT-ID.md)
2. [Landed intent](plans/VISION-NEXT-SPEC-LANDED-INTENT.md)
3. [Backlog convergence](plans/VISION-NEXT-SPEC-CONVERGE.md)

## The end state

The [north star](NORTH-STAR.md#vision) asks for a fleet that optimizes
verified engineering yield: useful accepted changes per token and hour. The
most capable version of that fleet is not a bigger swarm. It is one engineering
entity that:

- **knows what it did**: every outcome is attributed to exactly one attempt,
  with its model, tier, arm, usage coverage and durability;
- **refuses redundant work**: nothing launches, waits or merges when its net
  change is already on master;
- **converges its own backlog**: every open PR has one next action backed by
  a proof, and production is admitted by measured flow, not by a count;
- **learns from accepted work**: routing, harnesses and bets are chosen by
  measured yield against a frozen evaluator, keeping the incumbent when
  evidence is incomplete;
- **ships products, not PRs**: integrated candidates advance safely and a
  sister product reaches users through the same loop;
- **earns autonomy**: the owner signs bounded evidence packets instead of
  reviewing steps, and new authority stays an explicit decision.

## What the evidence says now

These inputs ground the ranking: the [autonomy gap](AUTONOMY-GAP.md#function-map),
the [yield definition](UNIVERSE-AUTONOMY-RESEARCH.md#verified-engineering-yield),
the [swarm and RSI research](research/agent-swarms-rsi.md#experiment-protocol-shared-by-every-idea),
the last 200 commits on master, and the bridge evidence reports. The
coordination research digest named for this job could not be read from the
worker sandbox, and the open-PR list could not be queried. Open-PR facts below
come from the most recent committed triage, not a live read.

**The fleet produces faster than it can attribute or converge.** Of the last
200 commits, about 75 were drain, rebase and CI-fix waves. Thirteen were empty
and about twenty only added a triage note. The merge pipeline itself is fast
(p50 2.6 minutes), but the
[merge acceleration report](https://github.com/ashlrai/phantom/blob/master/.bridge-evidence/RQ-SWE3-MERGE-ACCEL-1-report.md)
counted 13 of 260 merges (5%) that changed no files and 140 PRs closed unmerged
at a median age of 5.5 days. The
[PR triage](https://github.com/ashlrai/phantom/blob/master/.bridge-evidence/RQ-SWE3-PRTRIAGE-1-report.md)
found 170 of 236 open PRs needing a rebase.

**Churn marks three unsolved root causes.**

| Repeated work | Iterations | Root cause | Move |
| --- | --- | --- | --- |
| REAP*: which attempt does this outcome belong to? | about 6 | No row carries an attempt identity; five readers infer it from launch order | RQ-VN-ATTEMPT-ID |
| Empty merges and redundant drain waves | 13 empty merges, about 20 triage-only commits | Precheck proves completion by job ID or path, never by content | RQ-VN-LANDED-INTENT |
| PARK*/MERGE*Q8: rewriting the open-PR count gate | about 10 | Admission throttles on a count the fleet inflates; dispositions are read-only | RQ-VN-CONVERGE |

**The learning machinery exists but has no trustworthy reward.** Bandit
routing, assignment receipts, `PortfolioShadowV1`, the harness archive, GEPA
prompt optimization and lesson trials are all present. The
[function map](AUTONOMY-GAP.md#function-map) lists them as unwired or missing a
proposer. Each needs per-attempt yield first.

## Ranked moves

Ranking weighs what each move unlocks against its cost and risk. It follows the
[friction loop doctrine](doctrine/FRICTION-LOOP.md): remove the human step, not
the gate; if it is not measured it is not fixed. A move depends only on
higher-ranked moves, so the rank order is also a valid build order.

| Rank | Move | Pillar | Depends on | Owner review |
| --- | --- | --- | --- | --- |
| 1 | RQ-VN-ATTEMPT-ID: one minted attempt identity | foundation | none | no |
| 2 | RQ-VN-LANDED-INTENT: refuse work already on master | foundation | none | no |
| 3 | RQ-VN-CONVERGE: flow admission and proof-carrying dispositions | foundation | 1, 2 | yes (host install) |
| 4 | RQ-VN-YIELD: verified yield per attempt | self-improvement | 1 | no |
| 5 | RQ-VN-ROUTING: route by measured yield | self-improvement | 4 | no |
| 6 | RQ-VN-INTEGRATE: portfolio integration and CAS advancement | product factory | 3, 4 | no |
| 7 | RQ-VN-LADDER: earn the next autonomy stage | foundation | 3, 4 | yes (signature) |
| 8 | RQ-VN-VALUE-PLANNER: measured value chooses the next bet | product factory | 4, 5 | no |
| 9 | RQ-VN-HARNESS-RSI: harness archive with a frozen evaluator | self-improvement | 4, 5 | yes (design review) |
| 10 | RQ-VN-PRODUCT: one sister product end to end | composition | 6, 7, 8 | yes (enrollment, release) |

```text
ATTEMPT-ID ──┬──────────────► YIELD ──┬──► ROUTING ──┬──► VALUE-PLANNER ─┐
             │                        │              └──► HARNESS-RSI    │
LANDED-INTENT┴──► CONVERGE ──┬────────┼──► INTEGRATE ───────────────────┼──► PRODUCT
                             └────────┴──► LADDER ──────────────────────┘
```

### 1. RQ-VN-ATTEMPT-ID

The dispatcher mints one attempt ID at launch. Launch, finish, publish and
outcome rows carry it, and one fold in TypeScript and Python reads it. This is
the foundation every learning loop needs, and it ends the reap churn. It needs
no dependencies and no new authority.

### 2. RQ-VN-LANDED-INTENT

A `git merge-tree` containment check against the current base yields a
content-addressed `landed` receipt. Launch precheck accepts it as completion;
the closer reuses it as proof. This is the cheapest way to recover throughput,
because it removes a whole class of work instead of speeding it up.

### 3. RQ-VN-CONVERGE

A pure planner gives each open fleet PR exactly one disposition (merge, update,
rebase, close as landed, close as superseded, or ask the owner). Every close
must carry a proof receipt. Admission is driven by measured inflow and outflow,
replacing the 150-PR count gate. Apply runs only through existing ledgered
paths. Installing it on the host needs the Security re-pin the restocker
already requires.

### 4. RQ-VN-YIELD

Each settled attempt gets a yield record: accepted, durable, reverted, empty or
abandoned, with usage coverage. The eval report groups these by lane, model,
tier and A/B arm. Failures stay in denominators, unknown usage stays unknown
and reversals are appended. This is the reward signal for moves 5, 7, 8 and 9.

### 5. RQ-VN-ROUTING

The existing bandit and assignment receipts are fed by per-attempt yield,
first in shadow mode and then promoted after a matched comparison. Account
exclusions and reserves apply before preference. This delivers
[milestone 3](NORTH-STAR.md#three-implementation-milestones), learning the
division of labor.

### 6. RQ-VN-INTEGRATE

Integration and handoff become nodes in the checkpointed portfolio graph. The
local candidate branch advances only by compare-and-swap on fresh combined
evidence. This turns parallel PRs into an integrated product while keeping
push and deploy authority separate.

### 7. RQ-VN-LADDER

Durable yield is assembled into the would-merge digests that the
[rollout ladder](STANDING-AUTHORITY.md#the-rollout-ladder) requires, and one
Needs-you decision is filed when a stage is earned. Owner involvement becomes a
bounded signature on measured evidence.

### 8. RQ-VN-VALUE-PLANNER

Yield receipts calibrate the `PortfolioShadowV1` factors defined in
[living end state](LIVING-END-STATE.md#minimal-flow). A shadow planner then
proposes the next bets next to the current backlog, so the two can be compared
before either is adopted.

### 9. RQ-VN-HARNESS-RSI

An offline proposer fills the harness archive with prompt, playbook and
tool-policy variants. They are evaluated on a frozen held-out set with matched
comparators, keeping losing lineages. This follows
[Idea 3](research/agent-swarms-rsi.md#idea-3-preserve-diverse-candidate-lineages-instead-of-only-the-latest-winner).
Live self-modification of protected code remains out of scope.

### 10. RQ-VN-PRODUCT

The same loop carries one enrolled sister repository from hypothesis to a
released feature, measured by that repository's own acceptance suite and an
independent outcome observer. This tests whether the factory transfers beyond
Phantom.

## Considered and deferred

- **A durable cross-host agent bus** (push wake, dead letters): valuable once
  attempts and yield exist, but not on the critical path to attribution.
- **Larger best-of-N swarms**: published results reward topology matched to
  task dependencies, not more agents. The yield report must first show where
  parallelism pays.
- **Resident daemon re-activation**: owner-reserved per
  [the activation state](AUTONOMY-GAP.md#current-activation-state-315). Moves
  1 to 6 make that decision safer, but they do not require it.

## Invariants every move keeps

- A candidate may improve the evaluator but cannot rewrite the acceptance
  evidence used to select itself.
- Unknown usage stays unknown. Failed and timed-out attempts stay in
  denominators. Incomplete evidence keeps the incumbent.
- Ledgers are append-only. Reversals append. No history is rewritten.
- No move adds authority, spend, enrollment, release, force-push, ruleset
  bypass or trust-root changes. Those remain owner decisions under
  [CONSTITUTION.md](../CONSTITUTION.md) and [AGENTS.md](../AGENTS.md).
- Changes to `contrib/mac` host scripts are not live until their Security
  re-pin.
