# Grok resources beside Phantom

Use Grok Build for eligible local coding, and Grok Bot for persistent research and review on its cloud computer. Keep their execution identities, current funding evidence and results visible in Phantom. A plan badge alone cannot qualify an agent run.

The reviewed manual-copy handoff described below belongs to this source successor. This guide does not attest publication, installed acceptance or a commissioned Bot connector. Public vendor capabilities were checked on **2026-10-14**; account-specific eligibility, balances and billing settings were not inspected.

## Products and supported interfaces

| Resource | Vendor-supported capability | Phantom boundary |
| --- | --- | --- |
| Grok Build CLI | Local coding agent; interactive TUI, headless JSON streams, session resume/fork, worktrees, tool permissions and background tasks | Existing native CLI seats remain account-bound. New ACP support is documented by xAI but is not enrolled or commissioned in Phantom by this change. |
| SuperGrok, Plus or Heavy subscription | Existing consumer plans can fund eligible Grok usage and grant linked Bot usage under the legacy billing arrangement | A subscription tier is a funding claim, not a model ID, verified headroom or automatic dispatch permission. |
| Grok Bot | Named persistent agents on a cloud computer, messaging, connectors, skills and routines; work can continue with the laptop closed | Profiles and local coordination records identify intended recipients. This change supplies reviewed manual-copy briefs, not remote control. |
| xAI API | Programmatic model requests with an API key and applicable account/team billing | It is a distinct authentication route. Subscription coverage for a particular key/team must be verified; Phantom must not silently switch funding routes. |

Sources: [Build overview](https://docs.x.ai/build/overview), [headless and ACP](https://docs.x.ai/build/cli/headless-scripting), [Bot overview](https://docs.x.ai/grok-bot/overview), [API quickstart](https://docs.x.ai/developers/quickstart).

**A SuperGrok Heavy subscription label does not identify an exact available model or mode, or prove a CLI/API transport.** Consumer Heavy modes and subscription tiers are separate observations; lack of a qualified native catalog entry must not be presented as proof that a consumer Heavy mode is unavailable. The checked developer guide names `grok-4.7` as the coding model. Grok 4.7 Fast is available in Build and Cursor through their plans, with higher usage rates; it is not on the public xAI API. No current Heavy slug or dedicated Heavy interface was established by the inspected CLI/API sources. Qualify the actual seat's supported model catalog and transport before routing a specific variant. [Model guide](https://docs.x.ai/developers/grok-4-7).

## Legacy and unified billing

Existing SuperGrok, Cursor and X Premium plans can continue. Under the legacy Bot link, SuperGrok, SuperGrok Plus and SuperGrok Heavy grant progressively larger weekly Bot usage on the linked Cursor account. Cursor and linked grants do not stack; the larger grant wins. A legacy Bot grant is separately metered from its Grok consumer allowance. Plan refresh after a legacy upgrade can take up to 24 hours. [Legacy Bot plans](https://cursor.com/help/grok-bot/plans).

New self-serve customers use **The X Subscription**. Its individual tiers are Plus ($8/month), Premium ($30), Super ($100) and Ultra ($200), before taxes. The paid seat has one shared weekly pool across eligible first-party Grok/Cursor surfaces. Bot is included on Premium, Super and Ultra; **X Subscription Plus does not include Bot**. This Plus is distinct from legacy SuperGrok Plus. Switching is optional and changes which plan funds the account; completed unification is permanent. Do not infer that a user has switched from a display name. [Current pricing](https://docs.x.ai/x-subscription/pricing), [Bot on The X Subscription](https://docs.x.ai/x-subscription/grok-bot), [usage limits](https://docs.x.ai/x-subscription/usage-limits).

API coverage needs an exact route check. Current [consumer usage documentation](https://docs.x.ai/grok/faq) lists API in product breakdowns, and [pricing](https://x.ai/pricing) advertises API access. The [developer account FAQ](https://docs.x.ai/developers/faq/accounts) still describes separate API Console billing. These pages do not establish whether an arbitrary API key/team spends the user's subscription allowance. Do not label all API traffic either subscription-funded or separately paid. Leave that account-specific relationship unknown until verified.

For legacy Bot accounts, enabled on-demand usage is billed through Cursor after the weekly grant is exhausted; its monthly cap is not a hard stop during a running job. Unified accounts instead use their shared pool and supported Additional Usage/top-up controls. Check the relevant live account view, not a different product's meter. Unknown remaining allowance, reset, paid-use setting or identity stays unknown. [Legacy billing controls](https://cursor.com/help/grok-bot/plans), [unified extra usage](https://docs.x.ai/x-subscription/extra-usage).

## Review and copy a prepared Bot brief

Use **Add Grok reviewer profile** to prepare a local profile named **Phantom
improvement reviewer** with research and code-review responsibilities. Account
and Bot identities remain blank and required, planning starts off, and nothing
is saved until you choose Save. This does not create a Bot in the provider's
service; create the dedicated Bot there and enter its actual identity.

Start from an existing enabled Grok Bot proactive profile and an existing local task, prepared packet and current handoff intent. The saved profile records responsibilities and preferences; it does not prove account login, entitlement or Bot execution.

1. Open the current handoff's review dialog in Phantom.
2. Read the exact brief and its intended Bot recipient. Put the repository, PR number, exact head SHA and required evidence explicitly in the task goal/acceptance criteria when needed. Phantom does not invent or independently resolve those identifiers for the brief.
3. Acknowledge the displayed preview.
4. Choose **Recheck and copy brief**. Phantom rechecks the current server state and acknowledged digest, then copies only if the returned text matches exactly. If ownership, revision, recipient, profile, lease or deadline changed, review the new state before retrying.
5. In the chosen Grok Bot conversation, paste and send the brief yourself when ready. Copying it is not sending it.

The preview reads the exact saved local packet. In this milestone, `accountRefs` and `evidence` must be empty and source coverage is explicitly missing/incomplete. The complete brief is limited to 32KiB of UTF8 and refused if shared credential or generic home-path screening would alter its bytes; this is not a complete privacy guarantee. It does not collect provider context, transcripts, usage or credentials. The review response is temporary UI state; no new preview record is persisted. Existing prepared packets and the local coordination ledger retain their existing storage behavior.

For API clients, `POST /api/verse/proactive-agents/coordination/handoff-preview` requires the existing mutation token and `allowDispatch`. Input binds `taskId`, `attemptId`, `epoch`, `expectedRevision`, `profileId`, `expectedProfileVersion` and, on acknowledgement recheck, `expectedPreviewDigest`. The schema-version-1 response includes the bound IDs/versions, `packetDigest`, `previewDigest` and `briefText`, with `transport: "manual-copy"`, `dispatchAuthorized: false` and `contextShared: false`. Keep those flags intact; neither generating a preview nor placing it on a clipboard authorizes remote contact.

There is no commissioned automatic Bot dispatch, status, cancellation or result reader here. Handoff/cancel intent and a manually reported outcome remain local records. A pasted Bot report must be checked against current independent evidence before it qualifies a task. See the [coordination guide](https://github.com/ashlrai/phantom/blob/master/docs/PROACTIVE-COORDINATION.md).

## High-value roles and measured improvement

Use a Heavy-funded resource, when the actual model and funding are eligible, for difficult architecture options, adversarial PR review and diagnosis of a costly failure. Give it a specific question and a fixed evidence/result budget. “Heavy” alone is not a quality measurement.

Use a Bot's persistent cloud context for a narrowly scoped recurring research or release-review job. Ask it to reopen current GitHub checks, vendor documentation and deployment evidence, identify changes worth acting on, and return a linked report. Prefer one useful reviewed run before enabling a routine. All Bots on one account share a cloud computer, browser sessions and files, so separate Bot names are not security isolation. [Bot computer model](https://docs.x.ai/grok-bot/overview), [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

A practical review instruction is:

> Review the supplied PR and exact head SHA. Rank findings by verified impact and confidence. Suggest a bounded ambitious experiment with a measurable outcome. Separate source checks, publication, installation and live deployment evidence. Return proposals and missing evidence; do not publish, merge or change billing.

Judge improvements by independently verified fixes, resolved defects, accepted task outcomes and complete attributable usage—not confident prose or more agent activity. Preserve negative and incomplete outcomes. A Bot can propose a lesson or procedure, but it does not promote itself into Phantom policy, durable memory or execution authority. The [offline memory evaluation](https://github.com/ashlrai/phantom/blob/master/docs/MEMORY-EVALUATION.md) checks evidence contracts; it does not prove model task success or autonomous self-improvement.

## Background interfaces and handoff limits

The public [multi-agent research API](https://docs.x.ai/developers/model-capabilities/text/multi-agent)
documents the beta model `grok-4.20-multi-agent`, with four or sixteen cooperating
agents and multi-turn Responses API requests. It bills leader/sub-agent tokens
and server-side tools. This is a separate programmatic research candidate, not
proof of the consumer Heavy mode's identity, its availability in Build, or
subscription funding for a particular API key. The checked [retirement guide](https://docs.x.ai/developers/migration/may-15-retirement)
does not list this slug; actual current team availability and funding still
need qualification before a run. This source change does not call that API.

Build's documented ACP command is `grok agent stdio`, using JSON-RPC over stdin/stdout. The public example uses `initialize`, `authenticate`, `session/new` and `session/prompt`; assistant chunks arrive as `session/update`. Cached login and API-key methods are distinct. Headless mode offers `--output-format json` or `streaming-json`; `--no-auto-update` suppresses automated update checks. Phantom's current CLI seat does not become an ACP enrollment merely because xAI supports ACP. [Headless/ACP guide](https://docs.x.ai/build/cli/headless-scripting).

For durable CLI identity, `--session-id` creates a **new UUID**; `--resume <UUID>` continues an existing session, and `--fork-session` branches it. Read back the session ID from output. The older headless-page description of create-or-resume naming conflicts with the newer [sessions guide](https://docs.x.ai/build/features/sessions) and [official source guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md); qualify the installed version before implementation. A native dashboard attachment is not a supported Bot session URL.

Build `/loop` has a minimum 60-second interval, up to 50 scheduled tasks and seven-day expiry. Bot's documented routines have a minimum five-minute schedule, up to 50 routines per Bot and 20 retained recent run records; unattended routines may pause after long absence. These are vendor limits, not Phantom scheduler guarantees. [Build background tasks](https://docs.x.ai/build/features/background-tasks), [Bot routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

Cursor documents a **one-way routine webhook**: the desktop routine provides its POST URL and secret, and a 200 means accepted/started, not completed. This source change does not provision, store or send that webhook. The inspected docs do not establish a general personal-Bot create/status/cancel/results API or stable session deep-link/prefilled-message URL for Phantom. A future connector needs qualified account binding, funding, dispatch and independent result transport. [Webhook contract](https://cursor.com/help/grok-bot/routines).

Official entry pages are [Grok Bot](https://x.ai/bot), [Grok](https://grok.com) and the provider's documented billing views: [legacy Cursor](https://cursor.com/dashboard) or [unified Grok](https://grok.com/dashboard). These are navigation links, not task-submission interfaces.
