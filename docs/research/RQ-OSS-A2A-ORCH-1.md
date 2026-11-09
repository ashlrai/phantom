# RQ-OSS-A2A-ORCH-1 — open-source agent-to-agent communication and orchestration

Research date: 2026-11-06. Job: RQ-OSS-A2A-ORCH-1 (lane: devin, tier: work).
Status: research findings and recommendations only. No code, configuration,
queue, dispatchd, or credential change was made. No model calls, paid
resources, or network mutations were performed. Web research only.

## Scope and method

The slice covers agent-to-agent wire protocols, durable orchestration
runtimes, and subagent pattern libraries that could improve Phantom's fleet:
dispatchd, bus relays, multi-lane work, and director/subagent patterns.
Projects were found by web search (2025–2026 projects, comparison guides,
CNCF/Linux Foundation notes, GitHub topics `multi-agent`,
`agent-orchestration`, `a2a`) and checked against the Phantom needs in the
job spec: durable job handoff, priority, non-live async replies,
auditability, low model cost, and a fleet of one Mac plus hosted Linux box
workers.

Every `license (SPDX)` cell was verified on 2026-11-06 by reading the LICENSE
file on the repository's default branch (`license_url` column). Three rows
surfaced non-obvious licenses this way: **Inngest is SSPL-1.0**, **Restate is
BUSL-1.1**, and **multica is a modified Apache-2.0 with commercial
conditions** — none are OSI open source. AutoGen's root LICENSE is CC-BY-4.0
(docs); code is MIT in `LICENSE-CODE`. Mastra ships `ee/` directories under a
separate license.

## Decision summary

Adopt two things, in sequence. First, align the unimplemented agent-bus v2
contract with the A2A v1.0 object model (Task, Message, Artifact, AgentCard)
and use the Apache-2.0 TypeScript SDK when an external endpoint is wanted —
this buys a neutral, inspected wire shape instead of a Phantom-private one.
Second, run a spike between Hatchet (MIT) and DBOS Transact TS (MIT) as the
durable backend for cross-host job handoff, because the node router's lease
and fencing model is currently confined to one host's state directory while
the fleet already spans the Mac and a hosted Linux box. Everything else is
inspiration for patterns Phantom already half-owns, or a skip.

## Ranked adoption table

### (A) Wire protocols and schemas

| rank | project | url | license (SPDX) | license_url | effort | impact | Phantom fit note | recommend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Agent2Agent (A2A) spec + SDKs | https://github.com/a2aproject/A2A | Apache-2.0 | [LICENSE](https://github.com/a2aproject/A2A/blob/main/LICENSE) | S–M | 5 | Linux Foundation project (Google-donated); v1.0 stable. Task lifecycle (`submitted→working→input-required→completed/failed/canceled`), Message, Artifact and AgentCard discovery are a strict superset of bus v2's `work.post`/`work.status`/participant. JSON-RPC + REST + gRPC; `@a2a-js/sdk` (Apache-2.0, [LICENSE](https://github.com/a2aproject/a2a-js/blob/main/LICENSE)) is TS with Postgres/SQLite/D1 task stores and `a2a-inspector` for conformance. Adopt the object model now while bus v2 is schema-only; SDK later for an edge endpoint. BeeAI's ACP folded into A2A under the LF — the protocol is consolidating. | adopt |
| 4 | NATS + JetStream | https://github.com/nats-io/nats-server | Apache-2.0 | [LICENSE](https://github.com/nats-io/nats-server/blob/main/LICENSE) | M | 4 | Single static binary that runs on the Mac and the box; JetStream streams, consumer ack/redelivery and pull consumers map almost 1:1 onto Phantom's envelope TTL, claim lease and cursor polling. Top transport candidate if the durable bus ever goes multi-host; today it is a reference design, not a needed dep. | inspire-only |
| 8 | AGNTCY SLIM (+ OASF/dir) | https://github.com/agntcy/slim | Apache-2.0 | [LICENSE](https://github.com/agntcy/slim/blob/main/LICENSE) | L | 2 | MLS-encrypted group sessions, named-agent routing, plus schema (OASF, Apache-2.0, [LICENSE.md](https://github.com/agntcy/oasf/blob/main/LICENSE.md)) and discovery (`dir`) layers. ACP spec/SDK are archived — AGNTCY is consolidating on A2A bindings. Real value is E2EE + federated naming, which a two-node private fleet does not need yet. | inspire-only |
| 13 | Agent Network Protocol (ANP) | https://github.com/agent-network-protocol/AgentNetworkProtocol | Apache-2.0 | [LICENSE](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/LICENSE) | M | 2 | DID (`did:wba`, `did:web`) identities, HTTP message signatures, W3C proofs — the only candidate that solves the bus's acknowledged "labels are not identities" gap. Premature while every participant is inside one trust domain; revisit if counterparts go cross-org. | inspire-only |

### (B) Orchestration runtimes

| rank | project | url | license (SPDX) | license_url | effort | impact | Phantom fit note | recommend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | Hatchet | https://github.com/hatchet-dev/hatchet | MIT | [LICENSE](https://github.com/hatchet-dev/hatchet/blob/main/LICENSE) | M | 5 | Postgres-backed durable task queue with a TS SDK: worker slots, concurrency keys, rate limits, priorities, DAGs, event triggers, retries. Hatchet Lite is a single container — the lightest path to durable, fenced job handoff between Mac and hosted box without replacing dispatchd. Directly covers durable handoff + priority + failure recovery gaps. | adopt |
| 3 | DBOS Transact (TS) | https://github.com/dbos-inc/dbos-transact-ts | MIT | [LICENSE](https://github.com/dbos-inc/dbos-transact-ts/blob/main/LICENSE) | M | 4 | Library-only durable workflows/queues on Postgres — no orchestration server to run. Alternative to Hatchet for the same slot; weaker ops UI, smaller footprint. Pick exactly one after the spike. | adopt |
| 7 | Temporal | https://github.com/temporalio/temporal | MIT | [LICENSE](https://github.com/temporalio/temporal/blob/main/LICENSE) | L | 3 | The reference semantics for durable execution: activities, retries, signals, timers, replayable history. Server + persistence is heavy for a 2-node fleet; steal the workflow/signal vocabulary for bus v2 rather than the server. | inspire-only |
| 9 | Restate | https://github.com/restatedev/restate | BUSL-1.1 | [LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE) | M | 3 | Virtual Objects = keyed single-writer agents; durable awakeables model non-live replies; journals give auditability. **Source-available license (BUSL-1.1)** — cannot adopt under this job's rules; patterns only. | inspire-only |
| 12 | Dapr Agents | https://github.com/dapr/dapr-agents | Apache-2.0 | [LICENSE](https://github.com/dapr/dapr-agents/blob/main/LICENSE) | L | 2 | Virtual-actor agents with cryptographic identity, pub/sub collaboration, workflow durability. Kubernetes-first runtime weight is wrong for Mac+box; the actor-per-agent and crypto-identity ideas are worth noting. | inspire-only |
| 14 | LangGraph | https://github.com/langchain-ai/langgraph | MIT | [LICENSE](https://github.com/langchain-ai/langgraph/blob/main/LICENSE) | M | 3 | Checkpointer (Postgres/Redis) + supervisor/subgraph patterns are the cleanest published durable-agent-state design. Python-first; the TS port lags. Borrow the checkpoint/durable-state idea for swarm runners. | inspire-only |
| 16 | Inngest | https://github.com/inngest/inngest | SSPL-1.0 | [LICENSE.md](https://github.com/inngest/inngest/blob/main/LICENSE.md) | L | 1 | Event-driven step functions, good DX — but the server is Server Side Public License (verified in `LICENSE.md`), not OSS; SaaS-first. | skip |
| 18 | kagent | https://github.com/kagent-dev/kagent | Apache-2.0 | [LICENSE](https://github.com/kagent-dev/kagent/blob/main/LICENSE) | L | 1 | CNCF sandbox: agents as k8s CRDs, A2A-native, gVisor sandboxed sessions. Wrong substrate — the fleet is a Mac plus a shared hosted box, not a cluster. Revisit if a box fleet moves to k8s. | skip |
| 19 | Mastra | https://github.com/mastra-ai/mastra | Apache-2.0 (+ `ee/` dirs) | [LICENSE.md](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) | M | 2 | TS-native agent/workflow library — closest language fit — but `ee/` directories carry a separate license and the library duplicates Phantom's own swarm machinery without durable-handoff gains. | skip |

### (C) Subagent pattern libraries

| rank | project | url | license (SPDX) | license_url | effort | impact | Phantom fit note | recommend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | aden-hive/hive | https://github.com/aden-hive/hive | Apache-2.0 | [LICENSE](https://github.com/aden-hive/hive/blob/main/LICENSE) | S | 4 | Queen-worker colony: one agent loop, `run_worker` fan-out, SQLite `tracker.db` as shared state, playbook retries with rate-limited lanes and a dead-letter list, crash-resume from disk. The closest published analog to dispatchd+swarm; tracker/DLQ pattern is portable. Young (2026-01, rewritten at v0.10) — inspire, don't dep. | inspire-only |
| 6 | Microsoft Agent Framework | https://github.com/microsoft/agent-framework | MIT | [LICENSE](https://github.com/microsoft/agent-framework/blob/main/LICENSE) | S | 4 | AutoGen+Semantic Kernel successor (both now maintenance-mode), v1.0 GA. Five named orchestration patterns — sequential, concurrent, group-chat, handoff, magentic — plus checkpointing. Best single taxonomy to structure Phantom's swarm-planner patterns around. | inspire-only |
| 10 | OpenHands | https://github.com/All-Hands-AI/OpenHands | MIT | [LICENSE](https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE) | M | 3 | Agent Server REST API running many agents per host; event-stream action/observation architecture; delegate-subtask built in. Reference for a local multi-agent runtime API on the box. | inspire-only |
| 11 | OpenAI Agents SDK | https://github.com/openai/openai-agents-python | MIT | [LICENSE](https://github.com/openai/openai-agents-python/blob/main/LICENSE) | S | 3 | Handoffs + guardrails + triage agent: the pattern most fleets actually use for router–specialist. Provider-leaning; treat as pattern reference (Phantom already wraps `codex exec`, not this SDK). | inspire-only |
| 15 | CrewAI | https://github.com/crewAIInc/crewAI | MIT | [LICENSE](https://github.com/crewAIInc/crewAI/blob/main/LICENSE) | S | 2 | Role-based crews + event-driven Flows. Fast prototyping; persistence is in-memory/external — does not meet durable-handoff needs itself. | inspire-only |
| 17 | multica | https://github.com/multica-ai/multica | Multica License (Apache-2.0 + conditions) | [LICENSE](https://github.com/multica-ai/multica/blob/main/LICENSE) | M | 2 | Issue-driven agent workspace over agent CLIs with a per-machine runtime daemon — conceptually nearest to Phantom's fleet. **Source-available, not OSI**: hosted/embedded use needs a commercial license; internal use is allowed. Inspiration only. | inspire-only |
| 20 | CAMEL-AI | https://github.com/camel-ai/camel | Apache-2.0 | [LICENSE](https://github.com/camel-ai/camel/blob/master/LICENSE) | S | 2 | Role-playing societies, debate, workforce patterns — research-grade; useful for pattern breadth (debate/best-of-N), not infrastructure. | inspire-only |
| 21 | AutoGen (maint. mode) | https://github.com/microsoft/autogen | MIT (code); CC-BY-4.0 (docs) | [LICENSE-CODE](https://github.com/microsoft/autogen/blob/main/LICENSE-CODE) | S | 1 | Superseded by Microsoft Agent Framework; root LICENSE is CC-BY-4.0 which trips up naive license scanners. | skip |
| 22 | AG2 (AutoGen fork) | https://github.com/ag2ai/ag2 | Apache-2.0 | [LICENSE](https://github.com/ag2ai/ag2/blob/main/LICENSE) | S | 1 | Community fork of AutoGen on the same trajectory; nothing Phantom needs that MAF doesn't cover. | skip |
| 23 | MetaGPT | https://github.com/FoundationAgents/MetaGPT | MIT | [LICENSE](https://github.com/FoundationAgents/MetaGPT/blob/main/LICENSE) | S | 1 | SOP/company roleplay; maintenance is slowing (agentindex snapshot) and the pattern doesn't fit autonomous dispatch. | skip |
| 24 | Agency Swarm | https://github.com/VRSEN/agency-swarm | MIT | [LICENSE](https://github.com/VRSEN/agency-swarm/blob/main/LICENSE) | S | 1 | Thin layer over the OpenAI Assistants/Agents APIs; adds provider coupling without new orchestration mechanics. | skip |
| 25 | OpenAI Swarm | https://github.com/openai/swarm | MIT | [LICENSE](https://github.com/openai/swarm/blob/main/LICENSE) | S | 1 | Educational, archived; superseded by the Agents SDK. | skip |
| 26 | ChatDev | https://github.com/OpenBMB/ChatDev | Apache-2.0 | [LICENSE](https://github.com/OpenBMB/ChatDev/blob/main/LICENSE) | S | 1 | Chat-company research demo; single-shot pipelines, no durable state. | skip |

## Phantom gap analysis

What Phantom already covers well: an implemented bounded append-only bus
with cursor reads, auth-gated mutation, P0–P3 priority and TTL ([AGENT-BUS
v1](../AGENT-BUS.md)); a lease+fencing node router with capability and owner
scoping, local auth and secret names only ([NODE-ROUTER](../NODE-ROUTER.md));
a file-based queue with READY/deps and operator claims
([QUEUE](../QUEUE.md)); dispatchd's lane targets, tick budgets and route
hysteresis; swarm planner/runner phased fan-out; and a locked-down remote
gateway for off-Mac read/steer.

Where OSS is ahead, concretely:

1. **Cross-host durability.** The node router's lease/fencing state lives in
   a single-host directory (`~/.ashlr/nodes`); the hosted box is reached over
   SSH remote dispatch ([NODES](../NODES.md)). A Postgres-backed durable
   queue (Hatchet or DBOS) gives the box the same one-claim-per-job
   guarantees the Mac enjoys locally, with lease expiry and redelivery
   replacing manual reap passes. This is the largest real gap.
2. **Bus v2 is contract-only.** The claim table and work feed are "not yet
   implemented" per the docs' own ownership table. A2A's Task state machine
   is a proven superset of `work.post`/`work.status`; adopting its shape now
   (before the runtime lands) avoids inventing and later un-inventing a
   private protocol, and `a2a-inspector` gives free conformance checking.
3. **Interop boundary.** Today every provider needs a bespoke adapter
   (`src/core/fleet/bus-adapters/{codex,devin,grok}.ts`). An A2A JSON-RPC
   edge would let external agents — including non-TS providers — speak one
   neutral protocol, replacing per-provider file adapters at the boundary.
   Phantom's own `a2a-schema.ts` name also now collides with the industry
   term; worth noting in docs.
4. **Push/wake.** The bus is poll-only and the webhook relay is explicitly
   "not built". A2A push notifications, Hatchet event triggers and NATS
   deliver-now consumers are three proven patterns for waking a
   `wake.kind=webhook` participant without polling latency.
5. **Identity.** `from`/`to` are routing labels, explicitly "not identities".
   Inside one owner+LAN trust domain that is fine; ANP (DID+HTTP signatures)
   and Dapr's crypto agent identity are the references if counterparts ever
   go cross-org — inspire-only until then.
6. **Retry/dead-letter.** The queue has "no automatic reclaim, retry,
   promotion". aden-hive's tracker+DLQ and Hatchet retries are the two
   patterns worth porting for failure recovery.
7. **Auditability.** The append-only bus is a good base. Temporal/Restate
   journals show the bar: replayable per-job history. A durable backend
   (Hatchet/DBOS) buys most of that incidentally.
8. **Model cost.** All recommended adoptions are infrastructure and schema
   alignment — zero inference spend, consistent with the low-Grok-cost
   constraint.

Not recommended anywhere: heavyweight control planes (Temporal server, Dapr
sidecars, k8s runtimes), non-OSI runtimes as dependencies (Restate BUSL-1.1,
Inngest SSPL-1.0, multica conditions), and roleplay frameworks (MetaGPT,
ChatDev) which solve coordination, not dispatch.

## Proposed READY implementation one-liners

For the adopt items only, in dependency order:

1. `RQ-A2A-SCHEMA-MAP-1 (P2, pool=codex-cmp, tier=work, repo=phantom): Map agent-bus v2 bodies (work.post, work.status, work.claim, participant) onto the A2A v1.0 Task/Message/Artifact/AgentCard object model; ship zod validators + round-trip tests + a docs diff of incompatibilities. Acceptance: pure-schema change, no endpoint, no dep.`
2. `RQ-DURABLE-HANDOFF-SPIKE-1 (P1, pool=codex-cmp, tier=work, repo=phantom): Spike Hatchet Lite vs DBOS Transact TS as the durable store for node-router job handoff between Mac and the hosted box — fence a claim across two hosts, prove lease expiry redelivery, compare ops weight. Acceptance: hermetic dockerized PoC + decision doc; no dispatchd or live queue cutover.`
3. `RQ-BUS-V2-CLAIMS-IMPL-1 (P2, pool=codex-cmp, tier=work, repo=phantom, deps=RQ-DURABLE-HANDOFF-SPIKE-1): Implement the bus v2 claim table and work-feed endpoints from docs/AGENT-BUS.md on the backend chosen by the spike. Acceptance: acquire/renew/release/complete + feed per the contract's overlap rules, token-bound mutation, existing caps kept.`
4. `RQ-A2A-EDGE-ENDPOINT-1 (P2, pool=codex-cmp, tier=work, repo=phantom, deps=RQ-A2A-SCHEMA-MAP-1): Expose the durable bus as a loopback A2A JSON-RPC endpoint via @a2a-js/sdk with an AgentCard per bus participant. Acceptance: a2a-inspector validates the card; mutation gate and draft-approve boundaries preserved; loopback only.`

## Limitations

- Licenses verified 2026-11-06 against each default branch; projects can
  relicense (this survey already caught SSPL-1.0, BUSL-1.1 and a custom
  source-available license hiding behind "open source" marketing).
- The GitHub API was rate-limited from this host; repo metadata (stars,
  activity, maintenance status) comes from search-result snapshots dated
  ~2026-11-04 and repo pages, not a fresh API pull.
- aden-hive/hive is months old and was rewritten ground-up at v0.10; its
  patterns are recommended as design references, not as a dependency.
- No benchmark of Hatchet/DBOS on Phantom's real workload exists; the
  adoption call is deliberately a spike, not a cutover.
- MCP is intentionally out of scope per the job spec (sibling job
  RQ-OSS-MCP-SKILLS-1); nothing here depends on MCP internals.

## Sources

Protocol/projects: [a2aproject/A2A](https://github.com/a2aproject/A2A) ·
[a2a-js](https://github.com/a2aproject/a2a-js) ·
[a2a-protocol.org](https://a2a-protocol.org/latest/) ·
[AGNTCY](https://github.com/AGNTCY) /
[slim](https://github.com/agntcy/slim) /
[oasf](https://github.com/agntcy/oasf) /
[acp-spec (archived)](https://github.com/agntcy/acp-spec) ·
[ANP](https://github.com/agent-network-protocol/AgentNetworkProtocol) /
[anp SDK](https://github.com/agent-network-protocol/anp) ·
[NATS](https://github.com/nats-io/nats-server) ·
[Hatchet](https://github.com/hatchet-dev/hatchet) ·
[DBOS TS](https://github.com/dbos-inc/dbos-transact-ts) ·
[Temporal](https://github.com/temporalio/temporal) ·
[Restate](https://github.com/restatedev/restate) ·
[Inngest](https://github.com/inngest/inngest) ·
[Dapr Agents](https://github.com/dapr/dapr-agents) ·
[LangGraph](https://github.com/langchain-ai/langgraph) ·
[kagent](https://github.com/kagent-dev/kagent) /
[CNCF project page](https://www.cncf.io/projects/kagent/) ·
[Mastra](https://github.com/mastra-ai/mastra) ·
[aden-hive/hive](https://github.com/aden-hive/hive) ·
[MS Agent Framework](https://github.com/microsoft/agent-framework) ·
[OpenHands](https://github.com/All-Hands-AI/OpenHands) ·
[OpenAI Agents SDK](https://github.com/openai/openai-agents-python) ·
[CrewAI](https://github.com/crewAIInc/crewAI) ·
[multica](https://github.com/multica-ai/multica) ·
[CAMEL](https://github.com/camel-ai/camel) ·
[AutoGen](https://github.com/microsoft/autogen) ·
[AG2](https://github.com/ag2ai/ag2) ·
[MetaGPT](https://github.com/FoundationAgents/MetaGPT) ·
[Agency Swarm](https://github.com/VRSEN/agency-swarm) ·
[OpenAI Swarm](https://github.com/openai/swarm) ·
[ChatDev](https://github.com/OpenBMB/ChatDev)

License files: linked per row in the `license_url` column above (all fetched
on the default branch, 2026-11-06).

Comparison sources: [AgentIndex multi-agent
ranking](https://agentindex.app/en/best/open-source-multi-agent-frameworks/) ·
[GenAI Brief orchestration
ranking](https://genaibrief.com/tools/top-agent-orchestration-frameworks/) ·
[Hatchet vs Temporal](https://hatchet.run/versus/hatchet-vs-temporal) ·
[Microsoft Agent Framework
overview](https://learn.microsoft.com/en-us/agent-framework/overview/) ·
[Dapr agents announcement
(CNCF)](https://www.cncf.io/blog/2025/03/12/announcing-dapr-ai-agents/)

Phantom internals: [AGENT-BUS.md](../AGENT-BUS.md) ·
[AGENT-TO-AGENT.md](../AGENT-TO-AGENT.md) · [NODE-ROUTER.md](../NODE-ROUTER.md)
· [QUEUE.md](../QUEUE.md) · [NODES.md](../NODES.md) ·
[src/core/agents/bus-v2-schema.ts](../../src/core/agents/bus-v2-schema.ts)
