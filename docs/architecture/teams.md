# Phantom Teams: multi-human, multi-agent engineering

Status: **Phase 1 shipped** (local-first bus, claims, handoffs with approval
gates, scoped shared context, MCP tools, `phm team` CLI). Phases 2–4 below are
design, not shipped. This supersedes the unbuilt sync surface sketched in
[SPEC-V3-TEAM](../SPEC-V3-TEAM.md) and extends the read-only
[TEAM guide](../TEAM.md) / [Pulse bridge](../PULSE-BRIDGE.md).

## 1. Goal

One organization, many humans, many agent fleets across many vendors and
accounts (Claude Code, several Codex accounts, Grok Bot, Meta Muse, OpenAI
dots, Devin, local models), working in one engineering system without
collisions, without leaking client context, and with a human in the loop for
anything consequential.

Three pillars:

1. **Shared, company-agnostic context**, scoped by team/project/person and the
   Locus owner boundary (`personal` / `company` / `client:<name>`), retrieved as
   a compact, cited pack under a token budget.
2. **Proactive agent orchestration**: every agent registers, publishes,
   subscribes and hands off work through one protocol (MCP tools today, a
   webhook/event stream in Phase 2).
3. **Multi-human collaboration**: workspaces, presence, a shared fleet view,
   claims on repos/branches/paths, assignment and handoff between humans and
   fleets, roles, and an audit trail.

## 2. Architecture

```
 Claude Code ─┐   Codex(n) ─┐  Grok Bot ─┐  Meta Muse / OpenAI dot / Devin / local
              ▼             ▼            ▼
        phm MCP gateway: phm_team_* tools        humans: phm team … (CLI) / UI
              └──────────────┬──────────────────────────┘
                             ▼
       $ASHLR_HOME/teams/<team>/events.jsonl   (append-only, mkdir-locked, 0600)
                             │  pure fold (src/core/teams/state.ts)
                             ▼
   members+presence · claims · handoffs · approvals · messages · context index
                             │  Phase 2: replicate lines
                             ▼
        optional self-hosted sync service (signed events, per-team ACL)
```

Event sourcing is the key choice: every piece of team state is a fold over an
append-only log, so replication is "copy lines you have not seen" (idempotent
by event id, see `importEvents`) and never needs merge logic.

## 3. Protocol v1 (`src/core/teams/protocol.ts`)

```ts
interface TeamEvent { v: 1; id: string /* <ms36>-<rand> */; ts: string; team: string;
  actor: { kind: 'human'|'agent'; id: string; provider?: string; onBehalfOf?: string };
  type: TeamEventType; payload: object }
```

| type | payload | fold rule |
|---|---|---|
| `member.joined` | `{memberId?, role?}` | first human = owner; only owner/admin grant roles |
| `agent.registered` | `{capabilities[]}` | agent member, role `agent` |
| `presence.heartbeat` | `{status}` | online if seen within 5 min |
| `message.posted` | `{channel, text}` | last 50 kept in view |
| `claim.acquired` / `claim.released` | `{target:{repo,branch?,path?}, reason, expiresAt}` / `{claimId}` | lease, TTL 1 min–24 h (default 2 h); conflicts refused at write time under the lock |
| `handoff.requested` | `{to?, title, detail, action?, contextRefs[]}` | `open`, or `awaiting-approval` if `action` is consequential |
| `approval.requested` / `approval.decided` | `{handoffId}` / `{approvalId, decision}` | only **human owner/admin** decisions apply |
| `handoff.accepted` / `completed` / `declined` | `{handoffId, result?}` | addressee (or anyone if unaddressed) accepts; only assignee completes |
| `context.added` | `{title, text, source, scope, tags}` | shared context entry with provenance |

Claim overlap: same repo, and branches not different, and paths equal or
prefix-related (a repo-wide claim blocks everything in that repo).

Consequential actions: `deploy, release, merge, rotate-secret,
external-message, delete, spend`. Agents can request them; nobody can accept
them until a human owner/admin runs `phm team approve <id>`. There is no MCP
tool that approves.

## 4. MCP tools (agents)

| tool | safety | purpose |
|---|---|---|
| `phm_team_register` | append | register agent + capabilities |
| `phm_team_publish` | append | message or status heartbeat |
| `phm_team_view` | read | members/presence, claims, handoffs, approvals, messages (`since` cursor = subscription by polling) |
| `phm_team_claim` | append | acquire/release repo/branch/path lease |
| `phm_team_handoff` | append | request/accept/complete/decline |
| `phm_team_context_add` | append | scoped context with provenance |
| `phm_team_context_get` | read | compact cited context pack under `budgetTokens` |

All go through the existing gateway pipeline: argument validation, kill switch
refuses writes, every call audited by argument keys only, output scrubbed and
capped at 32 KB.

Human CLI: `phm team view | join | approve | deny | claim | release | say`.

## 5. Shared context and context-window efficiency

* Scope filter first: `client:<x>` entries are returned only to `client:<x>`
  requests; `personal` only to `personal`; project/person narrow further.
* Rank with TF-IDF over title/tags/text.
* Compress per entry: sentence split, cross-entry sentence dedupe, keep the
  most query-relevant sentences in original order, fit to a per-item share of
  the budget. Every item keeps `source`, `author`, `ts` (provenance) and the
  pack reports `rawTokens`, `usedTokens`, `compressionRatio`.
* This mirrors the ashlr-core-efficiency "compact, cited" contract without a
  runtime dependency; Phase 2 swaps the compressor for the shared
  ashlr-core-efficiency/genome implementation behind the same `ContextPack` type.

## 6. Threat model

| threat | Phase 1 control |
|---|---|
| secrets in shared context or messages | every event is scrubbed with the shared secret detector and **refused** if anything credential-shaped is present; use `phm_` references from Phantom Secrets |
| client data crossing clients | owner-scope filter on retrieval; client ≠ client, personal never shared |
| agent self-approving deploys/rotations | approvals apply only from `kind: human` owner/admin; no approve tool over MCP |
| role escalation | members cannot promote themselves; only owner/admin grant roles |
| collisions between fleets | write-time claim conflict check under an exclusive lock |
| torn/forged lines | parser skips unknown/invalid lines; file mode 0600 |
| **spoofed actor ids** | Phase 1 trusts the local OS user (same machine, same trust as `~/.ashlr`). Phase 2 sync **must** sign events (per-member keys) and authenticate writers before accepting remote lines |
| runaway agents | global kill switch refuses all team writes |

## 7. Roadmap

* **Phase 1 (shipped):** protocol, local bus, claims, handoffs + approvals,
  roles, scoped context with compression, 7 MCP tools, `phm team` CLI, tests.
* **Phase 2:** self-hosted sync service (signed events, per-team ACL, SSE
  subscription stream + outbound webhooks), Verse UI team panel (one primary
  action: "Review approvals"), Pulse bridge emits team events as OTLP, claim
  check wired into Phantom dispatch so fleet runs auto-claim their branch,
  ashlr-core-efficiency compressor.
* **Phase 3:** proactive-agent adapters (Grok Bot, Meta Muse, OpenAI dots) that
  consume handoffs through their own sanctioned APIs, mapped from
  `phm_proactive_agents_*` profiles; Locus-backed identity for members; Devin
  and cloud lanes as handoff targets.
* **Phase 4:** cross-org federation, learned routing of handoffs to the best
  fleet, recursive self-improvement loops gated by the same approvals.

## 8. Decisions for the operator

1. Who besides Mason is owner/admin of the `ashlr` team.
2. Hosting for the Phase 2 sync service (self-hosted vs. phm.dev cloud).
3. Whether `merge` should stay consequential for green, reviewed PRs.
