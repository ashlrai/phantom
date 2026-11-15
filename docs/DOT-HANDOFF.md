# Dot handoff guide

Evidence checked against official OpenAI sources on **2026-11-04**. This guide
lets an agent hand a bounded task to Mason's personal OpenAI Dot — and read a
result back — without assuming an undocumented API, unlimited usage, or a
model name. No account access, test send, or live Dot transport was performed.
Companion docs: [Dots companion](DOTS-COMPANION.md) (operator workflow),
[Peer interfaces](PEERS-INTERFACES.md) (interface inventory, checked
2026-10-26), [Agent-to-agent](AGENT-TO-AGENT.md) (a2a schema),
[iMessage intake](IMESSAGE.md). Machine-readable summary:
`ashlr fleet dot-handoff [--json]` (offline, read-only; same claims below).

## What official sources establish

### The product

A **dot** ("your dot") is a personal always-on agent inside ChatGPT with its
own cloud computer and browser. It keeps working between conversations, can
pause and wake itself, and delegates work to ChatGPT Work or Codex. One dot
per eligible member. Sources: [Meet dots](https://learn.chatgpt.com/docs/dots),
[Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).

### Task handoff (documented surfaces only)

Work reaches a dot **conversationally** — there is no documented personal-dot
API (see Unverified). Surfaces:

- ChatGPT mobile app, desktop app, or desktop browser (not mobile web); voice
  call; Slack and Teams channels the owner connected.
- **Texting**: iMessage/RCS beta for US Pro users, strictly one-to-one — only
  the verified owner can text the dot, the dot cannot join group texts, text
  other people, or initiate calls. [Message your dot](https://learn.chatgpt.com/docs/dots/channels)
- A dot delegates outward to ChatGPT Work or Codex: local tasks need the **one
  connected personal computer** online with the ChatGPT app open; cloud coding
  tasks need a Codex cloud environment pre-created in Codex. Delegated tasks
  appear under the dot's **Activity**. [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory),
  [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)

### Proactive behavior and approvals

Proactive research is **read-only**: it cannot send messages to other people,
change content through plugins, or control a browser or computer. Scheduled
runs and proactive updates appear in the conversation; a schedule needs a
saved task with timezone, end condition and notification destination. An
automatic action review gates account-affecting or sharing actions; optional
custom rules offer act / act-on-request / ask-first / hand-off modes; sensitive
actions (passwords, payments, some deletes) go to the user. Pause, stopping a
delegated task, and canceling a schedule are separate controls.
[Controls](https://learn.chatgpt.com/docs/dots/controls),
[Privacy/security FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)

### Model

Docs say dots are powered by the GPT-6 family and are expanding to include
GPT-6.1 Terra, with different models for different parts of the work. The
exact model behind any task is **not documented** — never assume or pin a
model name.

### Usage and availability

- Dot conversations do **not** count toward ChatGPT usage limits; Work/Codex
  tasks the dot starts count against those products' limits as usual. The plan
  includes a deeper-work allowance with extended limits the first month.
- Availability: Pro 100/200/500 (18+, outside EEA/UK/Switzerland), Business
  Premium worldwide rollout, Enterprise admin-enabled and off by default; not
  for UAE data/inference residency workspaces. Enterprise preview is free
  2026-11-04 → 2026-11-18, then billing begins for enabled dots.
  [Access section](https://learn.chatgpt.com/docs/dots#access),
  [Getting started](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)

## Unverified — do not assume

- **Personal-dot API**: no official source documents creating a dot, sending
  it a message, subscribing to its events, polling its tasks, or reading its
  output. Every personal-dot surface is conversational or account UI.
- **Mason's account**: his plan, region, workspace and enabled features are a
  local observation (order t1635u), not documentation. Check the actual
  account before planning capacity.
- **Workspace Agents API**: real but a *separate* product —
  `POST /v1/workspace_agents/{id}/trigger` returns `202` + `conversation_url`,
  beta run-status polling exists, and **agent responses cannot be retrieved
  through the API**. It needs its own workspace agent access token and does
  not address a personal dot.
  [Trigger runs](https://learn.chatgpt.com/workspace-agents/trigger-runs)
- **Plugin MCP events**: an authenticated plugin can expose `events/list`,
  `events/subscribe`, `events/unsubscribe` for signed deliveries on a verified
  public HTTPS callback (user OAuth 2.1 + S256 PKCE). That is an inbound
  surface Phantom could serve, not a way to drive a dot; a delivery
  acknowledges receipt, not completed work.
  [MCP events](https://developers.openai.com/plugins/build/mcp-events),
  [Plugin auth](https://developers.openai.com/plugins/build/auth)

## Phantom boundary (verified in this repo)

- `openai-dot` in `src/core/agents/bus-v2-schema.ts` is a **routing label** in
  the `agent-bus.v2` contract — not an authenticated identity; claims grant no
  execution authority. Provider recognition ≠ transport.
- `src/core/agents/a2a-schema.ts` is **configuration-only**: it validates
  counterpart shape (`localOptIn`, `remoteOptInEvidence`, channel
  `email|slack|imessage`, `scope`), defaults disabled, and wires no runtime,
  transport, or send path.
- `src/core/comms/imessage-outbox.ts` and `sendIMessage` remain **owner-only**.
  This restriction does not describe the separate teammate transport.
- As checked in repository source on **2026-11-08**,
  `src/core/comms/imessage-teammate-transport.ts` provides
  `sendApprovedTeammateMessage` and `reconcileTeammateMessage`.
  A teammate send requires macOS, enabled/unpaused comms, a non-owner handle
  in the configured allowlist, local team/send-policy approval, and a fresh
  configuration check immediately before sending. Do not weaken these checks.
- `phm imessage poll --apply` stores allowlisted non-owner input in the local
  teammate inbox. The separate `phm imessage respond --apply` worker can
  generate and send approved teammate replies. These are mutating commands,
  not readiness checks. Teammate identity never becomes owner authority.
- Source availability does **not** establish that the installed host is current,
  that its responder is running, or that a specific remote Dot route is accepted.
  The offline handoff summary does not inspect configuration or prove delivery.

## Handoff checklist (Ashlr → Dot and back)

Use a configured and authorized route when available; do not make Mason relay
every message merely because the owner-only outbox is restricted. Unsupported,
unconfigured or unapproved steps still go to **needs-you** without widening
permissions. The official product limitations above remain distinct from the
local native transport's source capabilities.

1. **Scope.** Prepare a bounded task with a stable `handoff-id`, named repository,
   exact paths and observable acceptance checks. Keep credentials and private
   message bodies out of engineering handoff artifacts.
2. **Qualify.** Use `phm imessage doctor --json` for local readiness evidence.
   Separately establish the teammate route's configured approval and installed
   responder state. This offline summary is not that evidence.
3. **Deliver.** Where the route is already authorized and operational, use the
   existing teammate responder workflow described in [iMessage intake](IMESSAGE.md).
   An accepted send is not delivery proof. Reconcile the exact outgoing message;
   do not blindly resend an uncertain outcome. Otherwise use needs-you.
4. **Correlate.** Keep the `handoff-id` in the task and result. Allowlisted
   teammate replies have their own local inbox and hashed agent identity;
   they do not need to be relabeled as owner input.
5. **Review.** Verify returned SHAs, test claims and artifacts independently.
   Receipt or delivery proves neither completed work nor authority to execute it.

## Bounded task template

```
handoff-id: dot-handoff-YYYYMMDD-NN        # stable local id; dot must echo it
goal:        <one sentence — the outcome wanted>
repo:        <owner/name only>
paths:       <exact repo-relative paths to read or change>
acceptance:  <observable checks — named tests, files, or evidence links>
privacy:     local-only — no credentials, tokens, personal text or identifiers;
             the dot's cloud computer is outside the trust boundary
correlation: echo handoff-id in first reply and final result; report exact
             head SHA and evidence links
authority:   proposal only — no merge, push, spend or permission change implied
```
