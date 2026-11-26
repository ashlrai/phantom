# Bus protocol v1 contract

`phm comms bus` is the local agent-to-agent message plane. This contract
layers typed conventions over the unchanged bus v1 envelope
(`schema/bus.v1.schema.json`, `src/core/fleet/bus-envelope.ts`). It adds no
transport, no network hop and no execution. Labels, topics and kinds are
routing data. None of them authenticates a sender or authorizes work.

## Envelope

The wire envelope is still bus v1: `id`, `from`, `to`, `priority`, `ttl`,
`body`, plus the optional channel metadata. Protocol v1 lives inside the
opaque `body` under a reserved key:

```json
{ "id": "task-42", "from": "dot", "to": "fleet.deploy", "priority": "P1", "ttl": 600000,
  "body": { "protocol": { "version": 1, "kind": "task", "topic": "fleet.deploy", "payload_ref": "artifact:run-42/plan.md" },
            "text": "Roll the canary." } }
```

| Field | Rule |
| --- | --- |
| `protocol.version` | Must be `1`. Other versions are refused. |
| `protocol.kind` | `task`, `result`, `review`, `status` or `question`. |
| `protocol.topic` | Optional. A namespaced name, `fleet.*`, `repo.*` or `human.*`, with 1 to 4 further segments. It must equal the envelope `to`. |
| `protocol.payload_ref` | Optional opaque printable token, 1 to 256 characters. The bus never fetches or interprets it. |

Unknown protocol fields, a non-object `protocol` or a mismatched topic are
refused on post with exit 2, before any write. Bodies without the `protocol`
key are untouched legacy bodies. The `{"kind":"work"}` body convention still
claims as a task.

Topic messages are addressed by setting `to` to the topic. The envelope gains
no mutable receipts field. Deduplication compares the exact bytes, so a
mutable field would break replay. Receipts come from the transport: the post
receipt `{status,id,cursor}`, the claim token and lease, and the completion
status.

## Topics and filters

- `phm comms bus read|watch --topic <name|ns.*>` matches an exact topic, or
  a namespace prefix on a segment boundary. `fleet.*` matches `fleet.deploy`
  but not `fleetx.deploy`. Patterns must be a valid name or a namespace
  prefix. Anything else exits 2.
- `--kind <task|result|review|status|question>` matches `protocol.kind`.
- `--thread <label>` matches the v2 `thread` field on `note`/`context`
  bodies only; every other body kind never matches. The label is printable
  ASCII, 1 to 128 characters; anything else exits 2.
- `--to`, `--from` and `--exclude-from` match the literal routing label or
  any other label of the same registered agent identity (handle, `agent:`
  address, stable id or alias), resolved once when the read starts; an
  unresolvable label or an unreadable identity registry keeps exact-label
  matching. `--id`, `--in-reply-to` and `--priority` keep their exact,
  case-sensitive meaning. Filters combine with AND.
- `--contains <text>` keeps only envelopes whose scrubbed one-line summary
  carries the needle as a case-insensitive substring, whitespace collapsed
  on both sides — the same `busReadContainsMatch` rule `agents bus inbox
  --contains` and `channel read --contains` apply. Matching runs over the
  rendered summary, never the raw body, so a secret-shaped value stays
  unfindable and protocol-v1 payloads stay opaque. The value is bounded
  free text, up to 512 characters; a blank or longer value exits 2.
- Filtered reads keep the cursor, limit and checkpoint semantics documented in
  `phm comms bus --help`. Checkpoints bind the new filters into their identity.

## Claims and leases

`phm comms bus next` and `phm comms bus claim` delegate to the existing lease
engine (`src/core/fleet/bus-work-claims.ts`, `bus-next-claim.ts`). They add no
new state:

- `next --to <address|topic> --owner <label> --lease-ms <1..3600000>
  [--id <envelope-id>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>]
  [--priority <P0|P1|P2|P3>] [--channel <name>] [--topic <topic>] [--from <agent>]
  [--exclude-from <agent>]`
  claims
  the oldest highest-priority live task addressed to `--to`. When `--to`
  resolves to a registered agent identity, work addressed under any routing
  label of that identity (handle, `agent:` address, stable id or alias) — or
  to a `group:<channel>:<topic>` address of a registry channel the identity
  belongs to, minus the identity's own channel posts — is eligible; a `--to`
  that names no identity, membership in no channel, or an unreadable registry,
  keeps exact-label matching. `--id` keeps only the receipt whose own wire id
  is strictly equal — the same exact-envelope match every bus `--id` read
  applies — so a hinted or listed envelope claims in one step under the same
  addressed-to, claimable-work and filter rules; `--contains`, `--since`, `--before`,
  `--priority`, `--channel`, `--topic`, `--from` and `--exclude-from` apply
  the same rules every bus read's filters do — the exact wire id, the scrubbed one-line summary
  substring, the inclusive `receivedAt` cutoff, the exclusive `receivedAt`
  ceiling composing with `--since` into one `[since, before)` window, the
  exact P0..P3 band, the `group:<name>:*` room prefix and the exact topic
  component of a well-formed `group:<room>:<topic>` address on the raw `to`
  label, and the sender identity-label match `agentRefAddressMatcher` shares
  (a sender ref resolving through the registry matches every label of that
  identity; an unresolvable ref or unreadable registry keeps exact-label
  matching) —
  inside the claim scan, so the claimable set is exactly what the matching
  read would list; a malformed value is `invalid`, never a widened claim. It
  returns
  `{status:'acquired', receipt, token, leaseUntil}` or
  `{status:'empty', candidates, held}`. `candidates` counts every live
  claimable receipt the bounded scan found addressed to `--to` and matching
  the request's filters, and `held`
  counts how many answered `conflict` — a live claim on the message id or an
  overlapping coordination key, possibly the requester's own. `candidates -
  held` failed acquire for other reasons (completed, expired, lost, missing,
  or a receipt that changed mid-claim); expired receipts never reach the
  scan. Both are observed counts over the filtered scan, so `empty`
  distinguishes a dry well
  (`candidates: 0`) from work that exists but is held, without a second read.
- `claim acquire --id <message-id> --owner <label> --lease-ms <n>` claims one
  message by ID. A live lease answers `conflict` to every other claimant.
- `claim renew|release|complete --id <message-id> --token <token>` act only
  with the token that acquired the lease. Renew reuses the original lease
  length. A completed task is never claimed again. An expired lease can be
  reacquired.

One claim row per message ID means one claimant per message, however many
agents watch the same topic. The token is a bearer lease handle, not an
identity. Treat it as sensitive: do not log it or paste it into a shared
channel. A crashed claimant's lease expires on its own.

## Exit codes

`next` exits 0 for `acquired` or `empty`, 2 for `invalid`, and 1 for any other
status, including `retryable`, `full` and `unavailable`. Claim verbs exit 0 for
`acquired`, `renewed`, `released` or `completed`, 2 for `invalid`, and 1
otherwise. Output is one JSON line.

## Non-goals

No fanout delivery, acknowledgement protocol, retries, TTL renewal or
authenticated identity. The bus does not execute, dispatch or publish anything.
The `fleet bus-*` commands keep their existing surface and call the same core.
