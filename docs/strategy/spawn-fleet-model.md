# Strategy: the Spawn fleet model vs Phantom's architecture

Job: RQ-SWE5-RESEARCH-LOOP (pool claude, tier frontier, repo phantom).
Date: 2026-11-08. Status: synthesis and design input for the research-to-spec
pipeline ([docs/RESEARCH-LOOP.md](../RESEARCH-LOOP.md)). This note changes no
authority, gate or schedule.

## What Spawn reports

Spawn is a roughly ten-person studio building a multiplayer game-creation
engine (players prompt an in-game agent, Savi, to edit a live world). Founder
Jacob Sansbury's account, amplified by Simon Willison on 2026-10-29, is
self-reported and unaudited; no eval harness, dataset or code was published.
Taken as design evidence rather than benchmark fact:

- **Permanent named agents, not per-task sessions.** Each fleet agent owns an
  area of the company (engine, Savi, ops, finance, bug triage, deploys), keeps
  memory of past work, holds real permissions and makes its own commitments.
  They spawn swarms of helper agents, reportedly thousands on most days.
- **Production is the work queue.** About 60% of work starts from a production
  error, a Savi-filed bug, a log anomaly or a feature request. A triage agent
  sorts each signal into fix / won't-fix / needs-a-decision. A fix reaches the
  affected user in about an hour.
- **No pull requests.** Agents change live code, product and database directly
  and coordinate through the code itself. A change that breaks other work must
  be reconciled before it counts as landed.
- **Fix forward on an hourly coherence bound.** Incomplete changes may land;
  everything must be consistent once an hour because an agent can hold only a
  few hours of work coherently. An hour without a ship is a SEV-0. Targeted
  rollback takes about 30 seconds; alerts wake the agent that owns the
  incident, and recovery paths are chaos-tested.
- **Split verification.** The full suite runs against latest code every 15
  minutes; helper agents that did not write a change try to break it;
  irreversible operations (payments) go through "dumb, hard-coded gates".
- **Spend as strategy.** Reported figures: 77,000 substantial changes in 30
  days (~108/hour), over $3M/month in tokens (~30x payroll), 1,055 of 123,548
  changes reverted (~0.9%) over a year. Only Fable 5/5.1 reportedly sustains
  the loop; other frontier models tried failed in specific ways.

## Mapping onto Phantom

| Spawn element | Phantom analog | Assessment |
|---|---|---|
| Permanent named agents with memory and area ownership | Lane pools + tiers routed by dispatchd; `phm memory` durable store; bus participants | Partial. Phantom routes work to pools by capability, but agents are per-job, not persistent owners. Spawn's ownership model is why production signals land with context; our `phm memory` plus per-repo CODEOWNERS could carry an "area owner" role without permanent processes. |
| Production signals feed ~60% of work | `phm radar` observations, harness digests, CI metrics, needs-you items, parked-dep gates | The signal intake exists but is scattered and mostly human-curated into jobs. The research loop adds a third stream: external engineering research becomes scored proposals rather than ad-hoc reading. |
| Triage agent turns signals into bounded work | `lintRestockDocument` admission gate + queuegen/restock generators | Spawn's triage is a model call; ours must be deterministic. Scoring + dedup + admission lint is the honest equivalent: the gate decides what may queue, not a model's judgment. |
| No PRs, direct-to-live, fix-forward | Worktree jobs, PRs, Merge Gate, merge queue, main-guardian | **Not adopted.** Spawn tolerates inconsistency because a game world forgives transient breakage; Phantom ships an engineering tool where merge checks are load-bearing and the constitution requires them. We take their cadence pressure, not their gate removal. |
| Helper agents attack unwritten-by-them changes | `phm fleet xreview` cross-model review, Merge Gate CI | Same idea, earlier in the pipe. Spawn reviews *after* landing; we review before merge. |
| Hard-coded gates for irreversible ops | Security GATES v3 (secret gate, pins, dispatchd install handoffs) | Direct match. Both systems learned the same lesson: the irreversible path is gated by boring code, not by agent judgment. |
| Hourly ship deadline, 30-second targeted rollback | dispatchd tick budgets, revert machinery, route hysteresis | Our rollback unit is the PR/commit, not a 30-second partial revert. The hourly coherence bound is a useful design constraint for digest cadence: a scheduled digest should emit few, bounded proposals an agent can hold coherently, not a backlog flood. |
| Swarms of helpers under named agents | Swarm planner/runner phased fan-out | Aligned already; ours is bounded and claim-scoped. |
| $3M/month token spend | Locality-vs-spend doctrine, budget verb, local-model lanes | Hard divergence. Spawn buys speed with spend; Phantom's doctrine spends deliberately and keeps local fallbacks. The research loop must be cheap: deterministic scoring, no model call in the read path. |

## Design principles the research loop takes

1. **Signals become proposals, never jobs.** Spawn's triage agent decides what
   ships; our equivalent emits scored, bounded proposals that still pass the
   admission lint and an explicit apply step. The review gate is the feature.
2. **Provenance is mandatory.** Every proposal names the digest sources it was
   derived from. A proposal without a source is malformed, mirroring how a
   Spawn signal without a production trace would be noise.
3. **Dedup is part of the gate.** A fleet that reads external research daily
   will keep rediscovering the same ideas; the scorer must check the queue and
   shipped-work evidence before proposing, the way Spawn's triage discards
   already-known bugs.
4. **Bounded by default.** Digest runs emit at most a handful of proposals so
   the review step stays cheap; volume is a defect, not a goal.
5. **Deterministic and free to run.** No model call, no network, no paid path
   in the digest reader; scoring is arithmetic a reviewer can reproduce.

## What the synthesis deliberately leaves out

- Permanent per-area agents with write authority (Spawn's core bet): worth a
  separate study; the research loop only borrows the *signal-to-work* shape.
- The hourly ship clock as a SEV-0: our cadence pressure is the dispatchd tick
  and lane slots; we do not ship to production on a timer.
- Any relaxation of Merge Gate, Security GATES or the hold list: the note
  adopts none of the no-PR posture.

## Sources

- Simon Willison link post, 2026-10-29:
  https://simonwillison.net/2026/oct/29/how-i-built-the-most-ai-pilled-company-in-the-world/
  (excerpts of Jacob Sansbury's Spawn post; linked original:
  https://twitter.com/jsnnsa/status/2115623382721126826)
- Shipping Skool case writeup (checked 2026-11-08):
  https://www.shippingskool.com/use-cases/spawn-team-ships-code-permanent-ai-agent-fleet
- ZeroNoise daily digest summary (checked 2026-11-08):
  https://zeronoise.ai/posts/spawn-drops-prs-and-ships-every-hour-with-a-fleet-of-fable-agents-langchain-gives-its-agents-a-browser-for-end-to-end-tests-nc1sdsian4ga0mil

All Spawn figures above are founder-reported; treat them as design evidence,
not measurements.
