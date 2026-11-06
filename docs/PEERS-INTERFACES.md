# Peer agent products: real programmatic interfaces

Verified against official provider documentation on **2026-10-26**. This is a
research inventory for the Phase 3 proactive-agent adapters sketched in
[Teams](architecture/teams.md#7-roadmap): what interfaces actually exist for
Grok Bot, OpenAI dots and Meta Muse, what each one authenticates and limits,
and whether Phantom should build an adapter. Only surfaces documented by the
provider count as real; a UI feature, a community report or a plausible
endpoint does not. Where a product has no sanctioned programmatic interface
for the job Phantom would ask of it, this document says so plainly instead of
recommending one.

Companion guides cover the operator workflows: [Grok Bot companion](GROK-BOT-COMPANION.md),
[Dots companion](DOTS-COMPANION.md) and [OpenAI Agents integration](OPENAI-AGENTS-INTEGRATION.md).

## Grok Bot (xAI, distributed with Cursor)

Grok Bot gives each account named Bots that work on one shared persistent
cloud computer. It is distinct from the Grok Build CLI seat and from the
metered xAI API. Access comes with paid Cursor plans, linked SuperGrok or
X Premium+, or a Grok Business seat. Sources:
[overview](https://docs.x.ai/grok-bot/overview) and
[plans and billing](https://cursor.com/help/grok-bot/plans), both checked
2026-10-26.

### Interface: routine webhook trigger (dispatch)

- **Type:** inbound HTTPS POST that starts one named routine run on an existing
  Bot. The routine and its instruction are created by asking the Bot in chat;
  the webhook cannot address an arbitrary Bot or inject a free-standing task.
- **Auth model:** a per-routine secret key shown only in the desktop app's
  routine details. Senders use `Authorization: Bearer <key>` and may attach a
  JSON body, which the Bot receives together with the routine instruction.
- **Limits:** HTTP 200 means Grok Bot accepted the call and started a run; it
  is not completion or a result, and no Bot result-polling API is documented.
  Routines run up to 300 times per hour in total and each routine up to 200
  times per hour; a shared provider-side limit can also fail runs and failures
  are not retried automatically. Each run spends the account's weekly usage
  pool or metered top-up credit.
  [Routines](https://cursor.com/help/grok-bot/routines), checked 2026-10-26.
- **Adapter recommendation: Yes.** A one-way dispatch adapter is sanctioned:
  store the key in Phantom Secrets, POST a bounded JSON body (repo, PR, head
  SHA, scope), record acceptance, and read outcomes in the Bot's chat or run
  history. Do not report a 200 as finished work.

### Interface: routine event triggers (provider-mediated)

- **Type:** schedules plus Slack, GitHub, Linear, Sentry and PagerDuty event
  triggers, and inbound email to the Bot's own `@mail.grokbot.com` address,
  all configured through the Bot conversation rather than a public API.
- **Auth model:** connected-app authorizations on the owning Cursor account;
  email routines default to senders that pass standard email authentication.
- **Limits:** same per-routine and hourly run limits as webhooks; one email
  address per account; routine-sent mail waits as a draft for approval.
  [Agent email](https://cursor.com/help/grok-bot/agent-email), checked
  2026-10-26.
- **Adapter recommendation:** none. These are sanctioned surfaces but they are
  configured inside the product, not callable by Phantom.

### Interface: plugins and MCP (incoming tool surface)

- **Type:** connected apps, Marketplace plugins and account MCP policy admit
  tools the Bot can call during its runs. This is a surface Phantom could
  serve (a scoped evidence MCP server), not a surface Phantom can call to
  drive a Bot.
- **Auth model:** per-app OAuth or plugin credentials held by the Bot's
  account; team MCP policy governs custom servers.
  [Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications),
  checked 2026-10-26.
- **Adapter recommendation: Yes**, scoped to the read-only evidence server
  already specified in the [Grok Bot companion](GROK-BOT-COMPANION.md#a-possible-future-phantom-connector).

### Interface: inference hooks (Enterprise governance)

- **Type:** outbound inspection webhook, in beta for Enterprise teams. Cursor
  POSTs each governed model request to the team's HTTPS endpoint and waits
  for an `allow` or `deny` verdict before the model sees it.
- **Auth model:** Standard Webhooks signing (`whsec_` secret;
  `webhook-id`, `webhook-timestamp`, `webhook-signature` HMAC-SHA256 headers),
  plus up to 16 custom headers the endpoint requires. The endpoint must be a
  public `https://` URL on port 443 that never redirects.
- **Limits:** Enterprise teams only and Grok Bot coverage only; verdict bodies
  up to 64 KiB, frames up to 64 MiB, verdict timeout 1 to 10,000 ms (default
  5,000), rollout percentage, shadow mode and a circuit breaker.
  [Inference hooks](https://docs.x.ai/grok-bot/inference-hooks), checked
  2026-10-26.
- **Adapter recommendation: No.** It is a governance inspection feed, not a
  way to assign or collect work, and it requires an Enterprise team Phantom
  does not operate.

### Not found

No official documentation describes an API to create Bots, send them
arbitrary messages, poll run results, or read a personal Bot's remaining
allowance. The Cursor Admin API covers team administration, not per-Bot
dispatch. Tagging `@bot` on X is a sanctioned trigger but regional and not
programmatic. Any two-way Bot integration remains unqualified; see
[Sources and limits](GROK-BOT-COMPANION.md#sources-and-limits).

## OpenAI dots

**What "Dot" actually is.** Official OpenAI sources identify the product
Mason calls a Dot: **your dot** is a personal always-on agent inside ChatGPT,
powered by GPT-6 Astra, with its own cloud computer and browser. It is not a
per-Codex-account product: one dot belongs to the ChatGPT account (Pro,
Business Premium or Enterprise workspace) and can delegate to ChatGPT Work or
Codex, including creating or continuing Codex tasks on one connected personal
computer and running tasks in Codex cloud environments. At launch each
eligible account gets one dot; OpenAI says more dots and per-dot scaling are
planned. Conversations with a dot do not count toward ChatGPT usage limits,
but the Work and Codex tasks it starts count against those products.
Sources: [Meet dots](https://learn.chatgpt.com/docs/dots) and
[Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot),
both checked 2026-10-26.

### Personal dot dispatch: no sanctioned interface

No official documentation describes an API to create a dot, send it a
message, subscribe to its events, poll its tasks, or retrieve its output.
The documented surfaces are conversational: ChatGPT apps on mobile, desktop
and web, voice calls, connected Slack and Teams channels, and texting as a
limited US Pro beta. Local task delegation flows through the dot's single
connected computer inside the ChatGPT desktop app, not through a network
API. **No adapter recommendation applies** because no real programmatic
interface for the personal dot exists as of 2026-10-26. The supported
companion workflow stays manual; see [Dots companion](DOTS-COMPANION.md).

### Interface: Workspace Agents trigger API (adjacent, real)

- **Type:** authenticated REST trigger for *published workspace agents*, a
  separate surface from personal dots.
  `POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger` queues a run
  and returns `202 Accepted` with a `conversation_url`. A beta header
  (`OpenAI-Beta: workspace_agent_runs=v1`) adds an `agent_trigger_run_id`
  (`apirun_…`) that `GET …/runs/{run_id}` polls for status.
- **Auth model:** `Authorization: Bearer <workspace agent access token>`
  provisioned per API channel; an `Idempotency-Key` header makes retries of
  the same trigger event safe.
- **Limits:** agent responses cannot currently be retrieved through the API;
  run status polling is beta; statuses are `queued`, `in_progress`,
  `suspended`, `completed`, `failed`, with `dispatch_failed` or `run_failed`
  error codes; scoped failures return 401, 403, 404 or 409.
  [Trigger workspace agent runs](https://developers.openai.com/workspace-agents/trigger-runs),
  checked 2026-10-26.
- **Adapter recommendation: Yes** for workspace agents that a workspace has
  deliberately published with an API channel. Do not represent it as a
  personal-dot dispatch path or treat `completed` as reviewed evidence; the
  response body still requires reading the linked conversation.

### Interface: ChatGPT plugins and MCP events (incoming tool surface)

- **Type:** the dot and ChatGPT can call connected plugins; an authenticated
  MCP plugin can also expose `events/list`, `events/subscribe` and
  `events/unsubscribe` so ChatGPT receives signed event deliveries on a
  verified HTTPS callback.
- **Auth model:** user OAuth 2.1 authorization code with S256 PKCE for the
  plugin connection; per-delivery signatures on event callbacks. A customer
  API key cannot substitute for the user flow.
- **Limits:** delivery acknowledges receipt, not completed work; a public
  HTTPS endpoint is required for publication, with a Secure MCP Tunnel for
  development. [MCP events](https://developers.openai.com/plugins/build/mcp-events)
  and [plugin authentication](https://developers.openai.com/plugins/build/auth),
  checked 2026-10-26.
- **Adapter recommendation: Yes**, as the inbound evidence and
  `fleet.review_ready` event surface specified in
  [Dots companion](DOTS-COMPANION.md#next-implementation-slice).

## Meta Muse

"Meta Muse" names three different products, and adapters differ per product:
the **Meta Model API** (metered inference), **Muse Code** (terminal and CI
agent) and the **personal Muse agent** (consumer app). Source:
[Meta Model API and Muse Code overview](https://dev.meta.ai/docs/overview),
checked 2026-10-26.

### Interface: Meta Model API (metered inference)

- **Type:** OpenAI- and Anthropic-compatible REST at
  `https://api.meta.ai/v1` with three request formats: Responses
  (`POST /v1/responses`), Chat Completions (`POST /v1/chat/completions`) and
  Messages (`POST /v1/messages`), plus Files, Models and an unauthenticated
  Status endpoint. Models include `muse-wonder-1.0` and
  `muse-spark-1.3`/`1.2`/`1.1` with discounted `-contributor` variants.
  [API reference](https://dev.meta.ai/docs/api-reference), checked 2026-10-26.
- **Auth model:** `Authorization: Bearer` with a `MODEL_API_KEY` created in
  the Model API dashboard; the OpenAI SDK works by changing base URL and key.
- **Limits:** per team, not per key. `muse-spark-1.3`: 3,000 requests/min and
  4M tokens/min; contributor variants: 150 requests/min and 3M tokens/min;
  background response submissions capped at 600/min; 429 responses carry
  `Retry-After`. Pricing is per token ($1.25 input / $4.25 output per 1M for
  Spark Standard, $0.15 cached input), plus per-image, per-hour and per-frame
  pricing for Muse Image, Voice Transcribe and SAM. Contributor mode trades a
  steep discount for permission to train on your content, which is a data
  governance decision, not just a price.
  [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits),
  checked 2026-10-26.
- **Adapter recommendation: Yes**, and it already exists as the opt-in
  `meta-muse` api-model engine (`muse-spark-1.3`, `MODEL_API_KEY`, off by
  default until added to `foundry.allowedBackends`). It is a model engine,
  not a peer-agent dispatch.

### Interface: Muse Code (agent CLI)

- **Type:** several documented programmatic surfaces:
  - `muse exec` headless runs: one prompt or `--prompt-file`, `--json` for
    JSONL events on stdout, `--session-id` to resume an interrupted run
    non-interactively, `--max-model-steps` to cap work, and `muse export`
    for an auditable run document. Exit codes: 0 turn completed (not proof
    the work is correct), 1 failure or cancellation, 2 usage error, 130/143
    on signals. `--disable-approval` keeps the OS sandbox while skipping
    prompts; `--yolo` removes both and trusts the workspace, so it belongs
    only in disposable containers.
  - Session messaging: named local sessions exchange plain-text messages up
    to 8,192 bytes with steer, queue or notify delivery and per-peer
    approval. Same user account and same macOS or Linux machine only; no
    cross-user or cross-machine transport; headless and `--no-session-log`
    sessions cannot participate.
  - Lifecycle hooks: project, user or managed `hooks.json` binds shell
    commands to events (`PreToolUse`, `PostToolBatch`, `SubagentStop`,
    `SessionEnd` and others). Hook commands run outside the sandbox.
  - MCP servers: stdio or streamable HTTP declared in `mcp_servers`, with
    OAuth 2.1 `muse mcp login` for remote servers; MCP tools are approved
    but not sandboxed.
  - Workflows and subagents: parallel children with optional worktree
    isolation; default execution capacity of 8 agents per tree, configurable
    from 1 through 64.
  Sources: [extending and automating](https://dev.meta.ai/docs/muse-code/extending),
  [session messaging](https://dev.meta.ai/docs/muse-code/session-messaging),
  checked 2026-10-26.
- **Auth model:** `META_API_KEY` (environment or `muse auth set`) for
  non-interactive runs, or browser sign-in for interactive use; Meta Managed
  Accounts must use an API key. Billing is pay-as-you-go per token or a flat
  monthly subscription whose key works only inside the Muse Code CLI.
  [Authentication and billing](https://dev.meta.ai/docs/muse-code/auth),
  checked 2026-10-26.
- **Limits:** subscription plans meter in prompt windows (Everyday Usage:
  10-50 prompts per 5 hours; High 5x, Power 20x with Muse Wonder Full,
  Maximum 80x that base) and default to Contributor mode, which must be
  switched off per machine or per run (`--contributor-mode off`) when sent
  content may not train Meta models. Pay-as-you-go runs follow the Model API
  rate limits above. [Subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions),
  checked 2026-10-26.
- **Adapter recommendation: Yes** for a CLI-seat engine adapter in the style
  of the existing Codex or Claude Code seats: dispatch through `muse exec
  --json`, gate on the task's own checks rather than the exit code, keep
  `--disable-approval` (sandbox on) as the automation posture, and resolve
  `META_API_KEY` through Phantom Secrets rather than config. Session
  messaging is a real interface but local-machine coordination only; treat
  it as an optional peer channel, not remote dispatch.

### Personal Muse agent: no sanctioned interface

Muse (the consumer app and web product at `ai.meta.com/muse`) is a personal
agent with its own Connectors to Meta and third-party apps, reminders,
scheduled tasks, approvals, skills, side chats and file access on a
connected Mac. The Meta Help Center documents connection and approval flows
but no API to dispatch work to a personal Muse, poll its activity or read
its results, and no self-serve Connector SDK: Connectors are provided by
Meta or third parties and authorized in the app's settings, so they are an
incoming tool surface, not a dispatch API. Sources:
[How to get started with Muse](https://www.meta.com/help/artificial-intelligence/1331373868832401/)
and [How Muse works with Connectors](https://www.meta.com/help/artificial-intelligence/1687253048996149/),
checked 2026-10-26. **No adapter recommendation**; a saved proactive-agent
profile records identity only and establishes no transport.

## Summary

| Product | Surface | Type | Auth | Limits | Adapter? |
| --- | --- | --- | --- | --- | --- |
| Grok Bot | Routine webhook | HTTPS POST trigger | Per-routine Bearer key | 200 = started; 300 runs/hr total, 200/hr per routine; no result API | **Yes**, one-way dispatch |
| Grok Bot | Schedule/event/email triggers | Provider-configured | Connected-app grants | Same run limits; drafts wait for approval | No Phantom surface |
| Grok Bot | Plugins and MCP | Incoming tools for the Bot | App OAuth + MCP policy | Team policy scoped | **Yes**, read-only evidence server |
| Grok Bot | Inference hooks (beta) | Outbound verdict webhook | Standard Webhooks HMAC + headers | Enterprise only; 64 KiB verdict; 10 s max timeout | **No** |
| OpenAI | Personal dot | None documented | n/a | ChatGPT surfaces only | None to recommend |
| OpenAI | Workspace Agents trigger | REST trigger + beta status polling | Bearer agent access token + Idempotency-Key | 202 accepted; response retrieval unavailable | **Yes**, published workspace agents only |
| OpenAI | Plugins + MCP events | Incoming tools; signed event delivery | OAuth 2.1 auth code + S256 PKCE | Callback receipt, not completion | **Yes**, scoped evidence plugin |
| Meta | Model API | REST inference (3 protocols) | Bearer `MODEL_API_KEY` | 3,000 RPM / 4M TPM per team; 150 RPM contributor | **Yes**, shipped as `meta-muse` engine |
| Meta | Muse Code | `muse exec` headless, JSONL, sessions, hooks, MCP | `META_API_KEY` or browser sign-in | Subscription prompt windows; contributor training default | **Yes**, CLI-seat adapter |
| Meta | Personal Muse agent | None documented | n/a | Connectors curated by Meta | None to recommend |

## Reading notes and caveats

- Acceptance versus completion matters on every dispatch surface: a 200 or
  202 acknowledges a run started or queued, never that work finished or was
  reviewed. Result evidence still lives in each product's own conversation,
  run history or linked conversation URL.
- Every "Yes" above assumes keys and webhook secrets resolve through Phantom
  Secrets at call time, are never stored in profiles or prompts, and that
  dispatch stays behind Phantom's existing spend and signed-authority gates.
- The three consumer agents (personal dot, personal Muse, individual Grok
  Bots) share the same gap as of 2026-10-26: rich in-product automation,
  thin or absent external control planes. Recheck provider documentation
  before commissioning any adapter beyond the webhook and trigger surfaces
  listed here; this inventory reflects one check date, not a standing claim.
