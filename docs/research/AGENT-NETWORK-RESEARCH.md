# Unified cross-vendor agent network

Research date: 2026-11-04. Status: proposed contracts, docs only. No adapter is
commissioned by this document. No credential resolution, outbound send, paid
service, TCC change, or deployment was performed.

## Decision and evidence boundary

Use the Phantom durable agent bus as the native source of work and receipts.
Use an internal shared Slack channel as the human-visible coordination surface,
with Socket Mode ingress. Add Telegram long polling, Gmail drafts, and a strictly
Mac-local iMessage adapter behind the same policy boundary. A2A provides optional
peer interoperability; MCP exposes bounded tools and resources. Neither protocol
provides a universal, trusted identity directory or permission to act.

The requested first step, reading every matching handoff file, is blocked:
listing `/Users/masonwyatt/.ashlr-runs/handoff/inbox` returned `Operation not
permitted`. An initial Python existence probe produced no files; that is not
evidence of an empty inbox. No handoff contents were read, copied, or inferred.
In particular, Ashlr.'s design has not been reviewed. Reconciliation below is
provisional against the queue requirements and repository evidence, not a claim
of agreement with the unseen design. Before implementation, list the inbox,
read all files whose filename or title mentions network, bus, Slack, iMessage,
or adapter, and replace this limitation with a file-by-file decision record.
Do not bypass host permissions to obtain it.

| Comparison available now | Agree | Difference and reason | Merged recommendation |
| --- | --- | --- | --- |
| Queue's shared Slack plus four adapters | One shared coordination surface and native Phantom bus | A shared Slack channel must be internal, not Slack Connect; an external audience violates default deny | Internal private channel, explicit team identity allowlist |
| Queue's A2A/MCP identity and message layer | Both are useful interoperability standards | Neither authenticates a vendor persona merely from its name | Local verified principal registry, protocol bindings at the edge |
| Existing agent-to-agent design | Bilateral consent, disabled default, local iMessage, draft approval | Team sends requested by the queue are broader than the current own-handle exception | Preserve stricter draft approval until a reviewed policy explicitly reconciles it |
| Existing bus v2 | Reuse participants, body kinds, work feed and claim rules | Contract presence does not mean resource-claim runtime exists | Implement missing coordination storage separately before channel execution |
| Ashlr. handoff | Unknown | Access denied; no defensible comparison possible | Reconcile before treating recommendation as final |

Checkout evidence: HEAD `e9e50be39`; local `origin/master` was `2c718fdd6`.
No fetch, checkout reset, or merge was performed. This report is not represented
as rebased onto current remote master. PR #3431's requested A2A shape is assessed
from the checked-in schema and guide, not from an independently retrieved PR.

## Existing components to extend

- [Native bus](../AGENT-BUS.md): six-field `BusEnvelope`, authenticated cursor
  reads at `/api/verse/agent-bus`, mutation-gated POST, bounded retention of
  1024 messages and 1 MiB. Same id and different bytes is a conflict, not an edit.
- [A2A consent configuration](../AGENT-TO-AGENT.md) and
  [`a2a-schema.ts`](../../src/core/agents/a2a-schema.ts): `enabled` defaults false;
  each counterpart requires `localOptIn: true`, `remoteOptInEvidence`, channel
  and scope. Current channels are email, Slack and iMessage; Telegram is absent.
  Nonblank evidence is shape validation, not proof of consent.
- [`bus-v2-schema.ts`](../../src/core/agents/bus-v2-schema.ts): participants and
  provider enum, seven body kinds, resource overlap rules, maximum one-hour
  leases and work feed shape. These are pure schemas, not runtime wiring.
- [`bus-work-claims.ts`](../../src/core/fleet/bus-work-claims.ts): local
  message-receipt claims keyed by id, cursor and receivedAt, lock-protected
  mutations, random token checks, expiry and terminal completion. This does not
  fence a remote provider or provide distributed consensus.
- [Existing provider adapters](../../src/core/fleet/bus-adapters/README.md):
  reuse Codex's host ports and Devin/Grok file adapters. Provider adapters run
  agents; channel adapters carry messages. Do not conflate these two boundaries.
- [`channel-bus-publish.ts`](../../src/core/fleet/channel-bus-publish.ts): existing
  Mason interjection projection has stable ids and best-effort append. Do not
  invent a second interjection format or treat best effort as durable delivery.
- Desktop Durable bus and the console's
  [`FleetBusMapPane.tsx`](../../src/web-ui/routes/verse/fleet-bus-map/FleetBusMapPane.tsx)
  should remain projections of existing receipts. Real iMessage must never enter
  a cloud-readable bus projection, including bodies, handles or attachments.

No runtime CLI/API surface is added here. Future surfaces require JSON output,
a plain-English section in `docs/AGENT-NETWORK.md`, a copy-paste example, and
entries in `docs/llms.txt` and `AGENTS.md`. Existing safe contract inspection:

```sh
npm run dev -- agents bus contract --json
```

## A2A and MCP mapping

Pin the [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
for the initial interoperability target and negotiate supported versions rather
than following a floating latest schema. Agent Cards advertise skills, endpoints
and security requirements; messages, tasks and artifacts carry peer interaction.
An advertised card is not proof of team membership. Authenticate its endpoint,
bind its key to a locally enrolled principal, and constrain discovery URLs to
trusted destinations to prevent SSRF. No public listener is required for our
outbound client; push notifications remain disabled.

| A2A concept | Phantom mapping | Required constraint |
| --- | --- | --- |
| Agent Card | Participant capabilities plus verified local endpoint binding | Card text cannot enroll itself or expand scope |
| Message id | Namespaced native envelope id | Persist wire mapping; retries keep identical bytes |
| Context id | Topic registry, Slack thread binding | Not an authorization boundary |
| Task id | `work.post.jobId`, subsequent `work.status` | Map lifecycle explicitly; do not pretend enum values match |
| Artifact | Local bounded reference or approved sanitized output | No automatic remote URL fetching or attachment transfer |
| Security requirements | Trusted launcher identity and request-time broker | Consent references are additional checks, not credentials |

Map submitted/working/input-required/completed/failed/canceled semantics to a
reviewed Phantom transition table. Preserve original state and task id in the
edge journal; input-required becomes blocked with a reason, cancellation requires
an explicit supported action. Streaming reconnect does not imply task restart.
Keep the six bus envelope fields unchanged. Use a separately versioned signed
network object inside opaque v1 `body` initially, projecting valid v2 bodies only
after verification. The strict v2 union rejects invented `kind` values.

Proposed state projection, with the original A2A state retained locally:

| A2A TaskState suffix | Phantom work status | Local detail |
| --- | --- | --- |
| SUBMITTED | queued | Task accepted, execution not confirmed |
| WORKING | running | Remote task active |
| INPUT_REQUIRED | blocked | Needs scoped input, not permission to send |
| AUTH_REQUIRED | blocked | Request-time broker/consent check; never relay credentials in chat |
| COMPLETED | done | Remote result recorded, channel delivery tracked separately |
| FAILED | failed | Sanitized failure code |
| REJECTED | failed | Preserve rejection as terminal reason |
| CANCELED | terminated | Confirmed remote cancellation |
| UNSPECIFIED | blocked | Unknown state, reconcile before new execution |

[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
is transport-scoped. HTTP clients use resource-bound authorization; stdio has a
separate local trust model. Expose tools for read, draft and policy inspection
separately from send. Phantom's stricter secret custody overrides examples that
use ambient credentials: only `phm_` references in persistent configuration;
resolve through `phantom exec` or the broker at request time. Do not pass provider
tokens between MCP and A2A audiences. MCP tool access cannot mint a team identity,
a work lease or send approval. Do not claim Codex, Claude, Devin, Grok Bot or
Cursor natively implement A2A without a tested provider-specific binding.

## Slack

Choose [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/):
an outbound WebSocket receives Events API payloads without a public inbound URL.
HTTP Events API delivery instead needs a reachable request URL and verification
of Slack's signed HTTP request. Socket Mode still needs Web API calls for replies.
Persist each event before acknowledging its envelope; acknowledgments and
reconnections do not confer execution authority. Use one active ingress owner,
expect reconnects and duplicate delivery, and do not equate a socket with an agent.

Start mention-only in one private, internal channel where the bot is invited:

| Credential | Minimum scope for proposed baseline | Purpose |
| --- | --- | --- |
| App-level reference | `connections:write` | Open Socket Mode connection |
| Bot reference | `app_mentions:read` | Receive explicitly addressed messages |
| Bot reference | `chat:write` | Team reply path, absent from read-only deployment if unnecessary |
| Bot reference | `groups:read` | Inspect private channel and paginated membership |
| Bot reference | `users:read` | Resolve member ids and membership attributes |

The [app scope](https://docs.slack.dev/reference/scopes/connections.write/),
[mention event](https://docs.slack.dev/reference/events/app_mention/),
[conversation inspection](https://docs.slack.dev/reference/methods/conversations.info/)
and [membership method](https://docs.slack.dev/reference/methods/conversations.members/)
define these permissions. Add `channels:read` only for a public-channel pilot;
`groups:history` or `channels:history` only if ordinary messages or recovery
history are required. A mention-only bot does not receive every thread reply.
Avoid DMs initially; they otherwise require their corresponding read/history
permissions and explicit routing. No `users:read.email`, `chat:write.public`,
admin scopes, file upload, channel creation or automatic joins.

Map `(workspaceId, channelId, root thread_ts)` to a stable opaque bus topic id;
store timestamps as strings. Replies use the root `thread_ts` with broadcast
disabled. Human messages become untrusted notes, never executable claims.
A shared bot signs as the bridge and records the verified human actor separately;
it cannot assert that a Slack display name proves a particular agent authored it.

[Slack Connect](https://docs.slack.dev/apis/slack-connect/) joins organizations.
Refuse externally shared, pending-shared and unknown conversations. Before each
send, inspect channel state and enumerate all membership pages. Compare immutable
user ids, workspace and enterprise bindings with the explicit team allowlist;
reject guests, deleted users, unknown bots and members whose membership cannot be
proved. The [user object](https://docs.slack.dev/reference/objects/user-object/)
includes membership attributes; email domains and display names are insufficient.
Invalidate cached evidence on membership/share changes and fail closed on lookup
errors. Even fresh checks have a membership-change race with posting: Slack offers
no atomic check-and-send audience lock. Use a locked-down internal channel and
retain drafts-only if the hard boundary cannot be assured. Confirmation never
overrides the no-outside-send allowlist.

Budget per method and workspace; handle 429 with `Retry-After`, jitter and bounded
queues. Slack's [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
include about one message/second/channel and 30,000 event deliveries/hour/workspace.
History and replies have special limits for certain commercially distributed,
non-Marketplace apps, including one request/minute and small pages; internal
customer-built apps differ. Verify installation classification before choosing
recovery cadence. Avoid history polling as the primary ingress and reserve
capacity for recipient checks. Unknown API outcomes enter reconciliation, not
blind resend. [Posting documentation](https://docs.slack.dev/reference/methods/chat.postMessage/)
defines reply routing; a successful post is not an end-to-end agent completion.

## Telegram

Choose outbound long polling over webhook, so no inbound listener is needed.
[Bot API](https://core.telegram.org/bots/api) delivery modes are mutually exclusive;
updates are retained at most 24 hours. Persist each update transactionally before
advancing `offset` past its `update_id`; one poller owns a bot. Restrict
`allowed_updates`, use positive long-poll timeouts, track gaps and report downtime
beyond retention as loss requiring operator reconciliation. Preserve ids as decimal
strings at adapter boundaries and handle group migrations explicitly.

Allowlist bot identity, numeric chat id and numeric sender id together. Group
membership alone is not team identity. Treat membership uncertainty as deny,
refuse forwarding as identity evidence, and disable inline/business paths unless
separately reviewed. Keep privacy mode enabled and avoid making the bot an admin.
The [Bots FAQ](https://core.telegram.org/bots/faq) explains that privacy limits group
visibility to addressed interactions, replies and selected events; bots do not
normally see other bots' messages. Telegram is consequently a human interaction
adapter, not a reliable vendor-bot mesh. Bot chats are not a local private data
store. Never bridge iMessage into them. Respect 429 retry instructions; paid
broadcasts are forbidden. Webhook fallback, if ever approved, needs HTTPS and its
secret-token verification plus its own security review.

## iMessage and macOS locality

Propose a Mac-only, read-only reader of `~/Library/Messages/chat.db`, then a
separately reviewed AppleScript sender through Messages. The database is an
unsupported internal interface, not a stable Apple API. Do not write to it,
assume `text` contains every message, or assume schemas and attributed bodies are
stable. Inspect only synthetic databases in automated tests. Use a WAL-aware
read-only connection and short snapshots, never copy just the live database or
mark a changing database immutable. [SQLite WAL documentation](https://www.sqlite.org/wal.html)
describes why committed records may live in sidecar files.

[TCC controls](https://support.apple.com/en-ca/guide/security/secddd1d86a6/web)
protect file access and Automation separately. The actual signed reader/launcher
may need Full Disk Access; controlling Messages requires Automation consent.
Accessibility is not a substitute. Mason handles consent dialogs. No TCC database
edits, permission resets, profiles or bypasses. Verify exact permissions on the
supported macOS version. Apple announced further [Full Disk Access controls](https://developer.apple.com/news/?id=p6zjojqw)
in October 2026, so legacy permission assumptions need revalidation.

Apple documents [inspecting an application's scripting dictionary](https://support.apple.com/guide/script-editor/view-an-apps-scripting-dictionary-scpedt1126/mac),
but that page returned 429 during this review. The installed Messages dictionary
and an approved synthetic-account exercise must establish supported send commands;
no runnable send example or successful delivery is asserted here. Construct
AppleScript parameters as data, not interpolated script or shell source. Resolve
an exact allowlisted handle and reject groups with unknown members, ambiguous
contacts, attachment commands and automatic SMS fallback. API return is not a
recipient delivery receipt; ambiguous outcomes require local reconciliation.

Real bodies, handles, contact graphs, attachments, database copies, derived
summaries and embeddings stay on the Mac. Only local oMLX at `127.0.0.1` may
process real content, with no cloud fallback, remote telemetry or shared-bus
projection. The private local journal and local-only drafts are excluded from
cloud agents, sync and CI artifacts. Any health counter exported must be content
free and separately approved; opaque ids can still reveal activity patterns.
Synthetic fixtures must use invented identities and text, never scrubbed real
messages. This research did not open the live database.

## Email

Prefer Gmail API for Gmail accounts: bounded OAuth scopes, provider ids and a
native drafts resource are easier to constrain than a combined mail client.
Use metadata-only access for routing where sufficient, `gmail.readonly` only if
body processing is required. Do not grant modify or full mailbox scope merely
to fetch messages. Poll with cursors initially; avoid a new push infrastructure.
Use history recovery and bounded resync when cursors expire, not guessed delivery.

[Gmail draft creation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create)
accepts `gmail.compose`, which also permits sending. There is no drafts-only OAuth
boundary here. Put the credential behind a method-allowlisting broker that exposes
only draft create/update/get, rejects `messages.send` and `drafts.send`, and
cannot be bypassed by raw HTTP tools. Local draft files are safer before that
broker exists. Gmail-hosted drafts still disclose contents to Google, so never
use them for real iMessage-derived data.

The [draft guide](https://developers.google.com/workspace/gmail/api/guides/drafts)
explains stable draft ids and replacement of underlying message ids. Persist draft
id, revision and digest; changes to content or To/Cc/Bcc invalidate approval.
Never treat a draft being absent as proof it was sent. Validate parsed MIME
recipients, aliases, Bcc and reply-all expansion; do not trust From/Reply-To or a
matching domain as team membership. Reject header injection and auto-replies.

IMAP/SMTP is a portability fallback, not the default. IMAP APPEND to Drafts does
not require SMTP sending, but mailbox conventions and UIDVALIDITY handling vary.
Keep SMTP credentials and execution unavailable in drafts-only mode. Gmail's
[IMAP/SMTP OAuth mechanism](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
uses the broad `https://mail.google.com/` scope, a disadvantage against API
scoping. RFC Message-ID is useful for correlation, not a provider-enforced
idempotency guarantee. Never send email automatically, even to team, until the
local `comms.toml` has `confirmedByMason=true` and all other approvals pass.
This work must not set that flag. Non-team messages remain local drafts only;
confirmation is necessary but cannot override the team-only hard limit.

## Identity, signatures and bridge loops

Issue a stable organization-owned agent id independent of vendor account or
session, for example synthetic `ashlr:agent:research`. Bind Codex, Claude, Devin,
Grok Bot and Cursor launcher identities to that id through locally enrolled
bindings; each active incarnation has a distinct session id and signing key id.
Two unrelated agents using the same vendor must never share identity. Reuse
v2 `participantId` for stable ids and the existing provider enum for bindings.
Display names, mailbox headers and claimed `from` values are untrusted labels.
Revocation disables bindings, queued sends and key verification as policy dictates.

Sign a domain-separated, versioned object using Ed25519 per
[RFC 8032](https://www.rfc-editor.org/rfc/rfc8032), canonicalized with
[JCS RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). Include organization,
message id, origin, actor, intended audience, topic, creation and expiry,
causation, classification and payload digest. Resolve signing keys through the
broker; never store private key material in channel configuration. Pin enrolled
public keys, support rotation/revocation, reject expiry and excessive clock skew,
and store replay keys for at least accepted message lifetime plus skew.
A bridge-attested human message is explicitly different from an agent signature.

Preserve the origin id across channel projections. Each bridge adds a separately
signed hop receipt binding the origin digest, previous receipt digest and
provider event id. Never rewrite the signed origin to append a route. Enforce
bounded hop count, no repeated bridge id, audience checks, echo suppression by
provider message id, and one outbox row per `(originId, destinationBinding)`.
Do not dedupe by text: identical text can represent distinct work. Channel edits
become new revisions with causation links; they cannot silently mutate an already
signed work order. Strip mentions, unfurls and executable markup from projections.

## Claims and delivery guarantees

Exactly-once external delivery cannot be promised across these providers. A
process can crash after a remote send succeeds and before recording its receipt.
Leases prevent concurrent local ownership but do not retract a remote side effect.
Use at-least-once intake with durable dedupe, exactly-once local acceptance within
the retained journal horizon, and explicit unknown outcomes for external sends.

1. Validate provenance, bounds, consent and classification; persist normalized
   source event plus dedupe index before acknowledging or advancing a cursor.
2. Append deterministic envelope bytes to the existing bus. On duplicate, accept;
   on conflicting bytes quarantine. Persist projection status so a crash between
   journal commit and bus append is recoverable. Do not recompute TTL on replay.
3. Acquire the existing message claim for work execution. Resource claims remain
   a separate v2 concern; implement their missing runtime with existing overlap
   rules before claiming distributed exclusion. Claims confer no send authority.
4. Atomically reserve an outbox item under a destination-specific idempotency key.
   A monotonic fencing epoch must be checked by the single sending authority;
   the current random local claim token alone cannot fence a remote call.
5. Recheck audience and approval against exact bytes immediately before sending.
   Record provider receipt and terminal state durably. Complete the work claim
   only after durable result recording; claim completion is not send completion.
6. Retry known pre-send failures and explicit throttles. For timeout after request
   transmission, mark unknown and reconcile using provider ids where possible.
   If no proof exists, require local review rather than automatic resend.

Journal/dedupe retention must exceed replay windows; the bounded native bus alone
cannot provide permanent dedupe. On disk pressure, key-store loss, exhausted caps
or uncertain state, stop intake/sends with an explicit health reason. Multi-Mac
operation needs one fenced leader per channel or a reviewed shared coordinator;
replicating local claim JSON does not make it distributed. The Desktop Durable tab
should show draft/blocked/unknown receipt states without displaying local data.

## Threat model against the four hard limits

All inbound text, attachments, cards and tool results are untrusted data. They
cannot enroll identities, grant consent, change policy, select secrets or trigger
spending. No new paid services or automatic upgrades. Every new diagnostic path
must be covered by `scrub.pl` before activation, with synthetic regression cases.
Prefer allowlisted metadata logging: never log bodies, auth headers, socket URLs,
Telegram token-bearing URLs, MIME, signing material or provider responses raw.

| Channel | Secrets | Money | Outside sends | Mason's data |
| --- | --- | --- | --- | --- |
| Native bus/A2A/MCP | Forged card/tool requests cannot select arbitrary vault refs; scoped broker, pinned principals | Work/claim is no billing authority; no purchasable tools | Authenticate origin and exact audience; no arbitrary discovery/wake URLs | Bounded payloads, private stores, ACLs; no real iMessage projection |
| Slack | Stolen bot/app refs or diagnostic URLs; request-time resolution, redact transport errors | No admin or paid provisioning capability | Connect/guests/unknown bots, membership races; deny shared channels, paginate checks, keep drafts when uncertain | Limit invited channel, no attachments/unfurls or broad history crawl; Slack receives permitted projected text |
| Telegram | Token appears in endpoint path; redact URL before all logging and retry traces | Paid broadcasts disabled, bounded rate queue | Numeric chat plus actor allowlist, migration review, refuse unknown group audience | Privacy mode, no contact upload, no iMessage; Telegram cloud sees permitted bot messages |
| iMessage | No key/handle leakage via AppleScript errors or subprocess argv | No purchases, no SMS fallback or paid relay | Exact local recipient binding and group audience check; local drafts until approved | Entire data path and inference local; no database export, sync, cloud logs or fixtures |
| Email | OAuth custody only in broker; no broad IMAP access by default | No paid relay or subscription changes | Draft-only broker, all recipient fields checked, header injection denied; confirmation never bypasses allowlist | Minimize mailbox scope; local drafts for sensitive data; no iMessage to Gmail |

Residual risks: compromised enrolled team accounts can inject malicious requests;
recipient membership may change at send time; provider outages exceed retention;
Mac-local privileged processes can access plaintext. Mitigate with least privilege,
read/draft defaults, bounded work admission and explicit uncertain delivery states.
A signature proves possession of an enrolled key, not that an instruction is safe.

## Recommended build order and acceptance gates

No downstream build-line names were supplied, so the stages below define concrete
scope without inventing queue ids. All remain proposed and disabled by default.

1. Reconcile every matching Ashlr. handoff and current origin/master. Record
   conflicts and the selected policy, especially the existing own-handle approval
   rule versus proposed team sends. Do not call reconciliation complete beforehand.
2. Pure contract and synthetic tests: identity bindings, consent evidence,
   signature vectors, classification, recipient allowlist, draft policy,
   canonicalization, origin dedupe and hop rules. Add Telegram to consent schema
   only through a reviewed compatibility change; no silent enum widening.
3. Journal and native bus integration: transactional inbox/outbox, cursors,
   bounded retention, crash recovery and fenced sender ownership. Reuse existing
   HTTP bus, provider ports and Durable tab, then implement missing resource-claim
   runtime separately. Test concurrent claims and stale-owner rejection.
4. Slack receive-only Socket Mode adapter for one internal channel, synthetic
   membership snapshots and local drafts. Test reconnect, duplicates, membership
   pagination, Connect/guest denial, event storage before ack and 429 recovery.
5. Telegram receive-only long polling and local drafts. Test cursor commit crashes,
   duplicate updates, chat migrations, unallowlisted actors and retention gaps.
6. Gmail local draft generation, then broker-isolated Gmail draft methods. Test
   To/Cc/Bcc, MIME injection, revised drafts and rejection of both send methods.
7. Mac-only iMessage reader and local draft builder after Mason grants required
   OS permissions. Test synthetic WAL databases and permission denial, with a
   network tripwire proving real-data routes cannot use cloud ports. Validate
   Messages scripting separately with synthetic accounts; no real-data CI.
8. Credential injection or send-capable implementation belongs in a separate PR
   on `codex-bridge/RQ-AGENTNET-RESEARCH-1-sec`, titled
   `[SECURITY REVIEW] RQ-AGENTNET-RESEARCH-1`, with no auto-merge. Add scrub coverage
   for each log path. Keep `confirmedByMason` unchanged, spending disabled and
   outside identities denied. This report creates neither that PR nor credentials.

Acceptance must include crash-after-send becoming unknown, stale lease failure,
revoked key/consent rejection, forged origin and repeated-hop rejection, a bot echo
loop, capped-store exhaustion and inability to send with missing confirmation.
Use affected-only tests with temporary homes and `--bail 1`; never weaken controls.

## Concrete TypeScript interfaces for implementation

These are proposed documentation contracts, not exported or runnable code.
Import existing types rather than duplicating provider or claim enums. Runtime
validators must reject unknown fields, enforce bounded lengths, verify bindings
and return scrubbed reason codes. `LocalMessageRef` is an opaque Mac-local journal
handle, never a path or permission to retrieve its contents remotely.

```ts
import type { BusBody, Participant } from '../../src/core/agents/bus-v2-schema.js';
import type { BusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import type { BusClaimRequest, BusClaimResult } from '../../src/core/fleet/bus-work-claims.js';

type AgentId = Participant['participantId'];
type Channel = 'native' | 'slack' | 'telegram' | 'imessage' | 'email' | 'a2a';
type SecretRef = `phm_${string}`;
type LocalMessageRef = string & { readonly localOnly: unique symbol };
type Classification = 'team' | 'mac-local';

interface IdentityBinding {
  agentId: AgentId;
  provider: Participant['provider'];
  sessionId: string;
  bindingId: string;
  channel: Channel;
  tenantId: string;
  subjectId: string; // immutable provider id, never a display name
  keyId: string;
  consentEvidenceRef: string;
  allowedScopes: readonly string[];
  revoked: boolean;
}

interface SignedOrigin {
  version: 'agent-network.v1';
  orgId: string;
  id: string;
  actor: { kind: 'agent' | 'bridge-attested-human'; bindingId: string };
  audienceBindingIds: readonly string[];
  topicId: string;
  createdAt: number;
  expiresAt: number;
  causationId?: string;
  classification: Classification;
  payloadDigest: string;
  keyId: string;
  signature: string; // excludes this field from canonical signing input
}

interface HopReceipt {
  bridgeId: string;
  originDigest: string;
  previousReceiptDigest?: string;
  providerEventId: string;
  keyId: string;
  signature: string;
}

type NetworkMessage =
  | { origin: SignedOrigin; hops: readonly HopReceipt[];
      classification: 'team'; body: BusBody }
  | { origin: SignedOrigin; hops: readonly HopReceipt[];
      classification: 'mac-local'; localRef: LocalMessageRef };
// Validate classification equals signed origin.classification.
// mac-local variants are rejected by all cloud/channel serialization ports.

interface InboundEvent {
  channel: Channel;
  bindingId: string;
  eventId: string;
  cursor: string;
  message: NetworkMessage;
}

interface AudienceProof {
  destinationBindingId: string;
  policyRevision: string;
  observedAt: number;
  expiresAt: number;
  teamOnly: true;
  memberIds: readonly string[];
  evidenceDigest: string;
}

type OutboundDecision =
  | { kind: 'deny'; reason: string }
  | { kind: 'draft'; reason: string; localOnly: boolean }
  | { kind: 'send'; audience: AudienceProof; approvalDigest: string };

interface Draft {
  id: string;
  revision: number;
  messageId: string;
  destinationBindingId: string;
  contentAndRecipientsDigest: string;
  localOnly: boolean;
}

type DeliveryResult =
  | { status: 'accepted'; providerMessageId: string }
  | { status: 'retryable'; retryAfterMs: number; definitelyNotSent: true }
  | { status: 'unknown'; reconciliationId: string }
  | { status: 'denied'; reason: string };

interface ChannelAdapter {
  channel: Channel;
  receive(after: string | undefined, signal: AbortSignal): AsyncIterable<InboundEvent>;
  acknowledge(eventId: string, signal: AbortSignal): Promise<void>;
  inspectAudience(bindingId: string, signal: AbortSignal): Promise<AudienceProof>;
  draft(message: NetworkMessage, destinationBindingId: string): Promise<Draft>;
}
// Implement this capability only in the separately security-reviewed sender.
interface SendPort {
  send(request: { draftId: string; revision: number; digest: string;
    decision: Extract<OutboundDecision, { kind: 'send' }>;
    idempotencyKey: string; fenceEpoch: number },
    signal: AbortSignal): Promise<DeliveryResult>;
}

interface NetworkJournal {
  // Atomic local accept and cursor checkpoint; conflict on same id/different digest.
  accept(event: InboundEvent): Promise<'accepted' | 'duplicate' | 'conflict'>;
  // Native projection always uses the existing strict six-field envelope.
  project(eventId: string, envelope: BusEnvelope): Promise<void>;
  claim(request: BusClaimRequest): Promise<BusClaimResult>;
  reserve(messageId: string, destinationBindingId: string): Promise<{
    idempotencyKey: string; fenceEpoch: number;
    state: 'reserved' | 'accepted' | 'unknown';
  }>;
  record(idempotencyKey: string, fenceEpoch: number,
    result: DeliveryResult): Promise<void>;
}

interface SecretBroker {
  // No method returns a secret value to adapters or models.
  sign(ref: SecretRef, canonicalBytes: Uint8Array): Promise<string>;
  createEmailDraft(ref: SecretRef, draft: Draft): Promise<{ providerDraftId: string }>;
}
```

Broker draft input in implementation must carry an opaque content handle bound to
the approved digest, resolved inside the broker. It must not fetch arbitrary paths
or URLs. The draft type above represents identity and revision, not complete MIME.
SendPort must revalidate policy, audience freshness, confirmation and exact bytes
inside the fenced sender; possession of a serialized `send` decision is not a
capability. Keep claims, broker references and private local refs out of public
channel projections. These constraints are part of the interface contract.
