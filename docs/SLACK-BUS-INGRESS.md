# Slack peer/group bus ingress

`src/core/comms/slack-bus-ingress.ts` provides an opt-in Slack Events API ingress
into the existing local Agent Bus. It is not registered with a listener, daemon,
CLI or MCP tool. Nothing runs merely because this module exists. No token is
created, stored or read by this module. It has no outgoing Slack operation.

## Trust boundary

The owning HTTP adapter must retain exact raw UTF-8 request bytes and pass the
Slack request timestamp/signature headers unchanged. Verification computes the
Slack v0 HMAC and uses a constant-time digest comparison. A `verified` field in
message content has no effect. Timestamp skew is bounded to five minutes old or
five seconds future. The event's own timestamp must meet the same age bound.
Oversized requests and text are rejected before local persistence.

The owner supplies a current installation policy and ephemeral signing secret
through trusted callbacks. Resolve that secret at request time through existing
Phantom Secrets custody; never put it in configuration, bus data or logs. An
absent or disabled policy returns disabled without requesting a secret or
creating the store. Policy is re-read for every event, and clock rollback is
refused within an ingress instance. Local code access to the policy, callbacks
or bus root is a trusted boundary; this module is not a sandbox for local code.

Workspace and receiving app must match the policy exactly. A peer must match
its exact Slack bot ID, app ID and user ID and also be allowed in that specific
channel. A route is only for a dedicated fleet-coordination audience with
current owner-verified membership. `is_ext_shared_channel` must explicitly be
false. This refuses Slack Connect; the policy label does not discover or verify
membership. Do not configure personal DMs or unrelated private conversations.
A future Phantom workspace needs its own installation policy and audience
verification; existing Ashlr authorization does not transfer automatically.

The canonical sender comes from that authenticated peer mapping, not text,
profile display names or metadata. A peer cannot map to `mason`. Input is stored
with `trust: untrusted` and fixed `kind: slack-coordination`, never `kind: work`.
It does not enter the owner channel receiver, invoke the work loop, select argv,
change authority or grant permission to send. Standard bus rows are routing
assertions, not cryptographic proof for downstream callers. Direct local bus
writers can forge rows; consumers must not grant authority from row labels.

## Peer/group protocol

This candidate accepts bot `message` or `app_mention` events, optionally with
`bot_message` subtype. Edits, deletes and other subtypes are ignored. Human
owner ingress is a separate future integration, not inferred from a peer post.
Self bot, user or app echoes are ignored.

Peer metadata must use `event_type: phantom_agent_message` and an event payload:

- `version: 1`
- `kind`: request, reply, note, status, decision or context
- `message_id`: bounded token, only a correlation claim
- `origin_bridge`: first entry of `visited_bridges`
- `visited_bridges`: unique bounded tokens, ending with the authenticated peer's
  configured bridge; the receiving bridge must not already occur
- `hop_count`: exactly the number of visited bridges
- optional `in_reply_to`: bounded correlation token
- optional `context_refs`: at most eight references

Incoming paths with four or more bridges are refused. The receiving bridge is
appended to the path. Origin history and correlation are untrusted claims, not
proof of who authored an earlier message. This module never automatically
answers requests or replies; it therefore cannot launch a reply loop. A future
outbound owner must preserve loop metadata and independently enforce send rules.

Each configured channel maps either to one direct peer destination or a bounded
group of at most sixteen local bus destinations. These routes are installed
policy, never parsed from message text. Group coordination is independent of
Mason's leader-facing conversation. The bus channel reference includes workspace,
channel and original thread timestamp. Metadata is deliberately bounded; message
attachments, arbitrary extra fields and full histories are not copied.

## Context and freshness

A reference contains only `id`, `revision`, `observedAt` and `expiresAt` (UTC
milliseconds), with expiry after observation. IDs/revisions are bounded tokens,
not URLs or filesystem paths. Extra fields and duplicate IDs are refused.

References remain `unverified-reference-claims` with `retrievalAuthorized: false`.
Their original timestamps are preserved, including stale references. Consumers
must resolve only through an authorized context catalog, confirm scope/revision,
check current expiry and supersession, and retrieve a small relevant subset.
This module does not claim the referenced evidence is current, authentic or
available, and does not fetch content, invoke a model or integrate full memory.

## Durable admission and retries

Validated events append directly to the existing private local bus store.
The caller must specify an absolute root. Existing store privacy, lock, atomic
snapshot and capacity rules remain in force. Receipts contain only static status,
counts and `sendAuthorized: false`, never event content, handles or signing data.

The message ID hashes workspace, Slack event ID and recipient. Exact retries
therefore deduplicate across restarted ingress instances. Changed content under
the same identity conflicts instead of silently replacing a prior message.
The six-minute bus retention exceeds the five-minute event admission window,
including allowed skew, so pruning cannot make an admissible replay fresh.
This is bounded deduplication, not eternal exactly-once delivery. Bus lifetime
starts at local receipt; context reference expiry is separate and must still be
checked by consumers. Normal private bus ownership and clock correctness apply.

Group fanout is separately durable, not atomic across recipients. On a failed
or uncertain append, the ingress stops and returns partial counts. It does not
retry automatically. A later exact retry reconciles already-persisted recipients
and can complete the remaining ones. A permanent conflict needs owner attention.
The HTTP owner must choose bounded response/retry behavior and account for events
that exceed the admission window, rather than treating an HTTP acknowledgement
as proof of fleet processing or outward delivery.

## Required integration before activation

Continue existing RQ-AGENTNET-SLACK-1, not a new parallel adapter or job:

1. Reconcile current owner claims and policy/audience bindings. Verify the exact
   app installation, bot identity and non-shared fleet channel membership.
2. Wire a supported HTTP ingress owner with bounded request/body/concurrency
   handling, exact raw-byte verification and count-only error reporting.
3. Supply ephemeral signing-secret custody and an explicit private bus root.
   Do not copy a connector/user-account token or modify access to make it work.
4. Add the independent outbound owner with current audience/allowlist checks,
   shared send policy, request-time bot token injection, durable reservation,
   rate limits, uncertain-send reconciliation and no user-account fallback.
5. Wire already-owned fleet consumers and bounded context retrieval. Do not
   turn untrusted inbound `request` text into autonomous execution authority.
6. Verify installed revision, host supervision and an explicitly authorized
   synthetic canary. No live delivery or deployment is implied by unit tests.

The offline tests use synthetic HMAC material, IDs, text, clocks and temporary
bus stores. No real Slack messages, identities, secrets or network calls are used.
