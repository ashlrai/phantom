# External bot seats

External bots are optional, provider-neutral seats in one Phantom roster. Seats
describe existing executors; adding one does not start a bot, grant authority,
acquire work, register an authenticated identity, or authorize spending. The
[Phantom Bots](BOTS.md) metadata and template records remain separate.

## Configuration

Create `~/.phantom/bots/seats.json` with schema `phantom-bot-seats.v1`:

```json
{
  "schema": "phantom-bot-seats.v1",
  "seats": [
    {
      "id": "devin-review",
      "kind": "devin-bot",
      "displayName": "Devin reviewer",
      "participantId": "devin-review",
      "capabilities": ["code", "review"],
      "quota": { "source": "devin-acu" },
      "secretHandle": "phm_devin_api_key"
    },
    {
      "id": "local-review",
      "kind": "local",
      "displayName": "Local reviewer",
      "participantId": "local-review",
      "capabilities": ["review"],
      "quota": { "source": "lane-budget", "lane": "omlx" }
    }
  ]
}
```

The file is strict: unknown fields, duplicate seat/participant ids, invalid
capabilities and secret-shaped values are rejected. `secretHandle` is a Phantom
Secrets **name only**, matching `phm_` followed by a lowercase letter and up to
63 lowercase letters, digits or underscores. Never paste a credential into any
field. The current Devin consumption reader uses its existing custody setup;
the handle is metadata, not a new credential-resolution path.

| Kind | Derived bus provider | Recommended quota source |
| --- | --- | --- |
| `devin-bot` | `devin` | `devin-acu` |
| `grok-bot` | `grokbot` | `lane-budget` with the existing lane name |
| `openai-bot` | `openai-dot` | `lane-budget` with the existing lane name |
| `local` | `local` | `lane-budget` with the existing local lane name |
| `other` | Explicit `provider` required, from Agent Bus v2 providers | Existing lane budget or `none` |

`nodeId` optionally associates a seat with its existing node-router node.
Non-`other` kinds derive their provider even if a provider field is supplied.
Local adapters are inert and loopback-only; no remote model endpoint is opened.
Missing configuration means an empty roster.

## Quota evidence and lifecycle

Quota is evidence, not a reservation or a spending authorization:

- `measured`: `usedPct`, `resetAt` (or null), `asOf` and `source` are present.
- `exhausted`: the same evidence fields, with usage at or above 100 percent.
- `unknown`: `reason` and nullable `asOf`; no invented numeric percentage.

Unknown or stale quota is **not available**, never zero. Only an `active` seat
with `measured` quota accepts new work. `none` is always unknown. Grok, OpenAI
and local seats use existing lane-budget evidence in
`<runs>/queue/budget-overrides.json`, interpreted by `budgetEntryQuota`.
Missing/null values, stale timestamps and expired resets become unknown with
reason `stale-or-missing`. No local estimate or provider allowance is invented.

```text
active -- exhausted quota --> draining -- no open work --> idle
  ^                                                        |
  +------- fresh measured evidence after reset -------------+
```

An idle seat returns to active only when measured usage is below 100, the
reading's `asOf` is after its idle time, and the recorded exhausted reset is
absent or has passed. Unknown evidence leaves the state unchanged. Explicit
invalid transitions (such as active directly to idle) throw. State is persisted
atomically in private `~/.phantom/bots/seat-state.json`; listing can persist a
lifecycle transition. Missing node storage is never initialized by observation.

## Inspect and hand off

```sh
phm bots seats --json
phm bots handoffs --json
phm bots handoff --seat devin-review --json
phm bots handoff --seat devin-review --apply --json
```

`phm bots handoffs` is the fleet-wide dry-run: one read reports every roster
seat's projected state, whether `planSeatHandoff`/`applySeatHandoff` would
accept it (`eligible`), and the pending handoff records it would journal —
the same deterministic ids a later per-seat apply dedupes on. Ineligible seats
(active seats, and idle seats with no open work or handoff history) report
`eligible: false` with no records instead of erroring, so the whole roster's
handoff posture reads in one call. It writes nothing: no state transitions,
releases, journals or notices. `phm comms inbox` lists each eligible seat
with pending handoff records as a `seat-handoff` item — the same plan read —
so pending seat work surfaces in the unified pending view without a second
lookup.

Handoff defaults to a dry-run plan. It refuses active seats; only draining seats
or idle seats with work may hand off (completed handoffs allow harmless replay).
Open work consists of live coordination claims owned by `participantId` — or by
any other routing label of the same registered bus identity (handle, `agent:`
address, stable id or alias), the same owner matching `claim list --owner`
applies — and running node-router jobs held by `nodeId`. An unresolvable
`participantId` or an unreadable identity registry keeps exact-label matching:
unknown identity state never widens what a handoff drains. The claim guard
`seatMayClaim` admits only active seats with measured evidence; this module
never acquires claims. Existing executors must call the guard to enforce seat
admission.

Apply uses a **write-ahead, exactly-once handoff record**: the SHA-256 id includes
the seat, work reference and fencing/lease identity. The private append-only
`~/.phantom/bots/handoffs.jsonl` record is fsynced before release. It includes
`done`, `left`, `branch` and `pr`; unavailable metadata stays `unknown` or null.
Re-running never appends the same handoff twice, and retries release while the
same claim is still held. Already-gone work counts as released. A stale-safe
local-store lock serializes apply operations.

Node jobs return to pending through `DriveNodes.release(claim, true)`; the
decline excludes the drained node session from receiving that job again, while
the router can offer it to other eligible nodes. Bus claims use the existing
claim-store release-by-source path. This is coordination release, not a promise
that another agent has started the work, and it does not stop a remote bot.

Each record has a bus note and owner-thread notice with stable deduplication
keys. Private `handoff-notices.json` receipts suppress repeated attempts; a crash
between sending and saving a receipt retries with the same key. The bus note
is one `note` envelope appended to the shared bus store addressed to `leaders`
— a system post from the seat's participant id with `origin_bridge`
`bot-seats`, not a channel message, so no bus identity registration or channel
membership is required. KILL and the comms pause refuse it like every other
local bus write; an unavailable store reports `unavailable`, never a claimed
post. Notification failures do not undo release or expose exception text: apply reports per-record
`notifications.bus` and `notifications.owner` statuses. A failed/halted attempt
is recorded, not automatically retried. Owner notices use the configured owner
thread, honor KILL and comms pause, and are local desktop notices, not proof of
external-channel delivery. Journal uniqueness does not imply exactly-once
execution or delivery across independent systems.

## Bus and console participation

`phm agents bus id list --json` adds a `participants` array from the seat roster
without modifying registered `identities` or `channels`. Its `--root` still
selects the identity store; seats come from the local seat configuration.
Each `phm bots seats --json` row also includes its Agent Bus v2 `participant`
record. Active maps to bus `active`; draining and idle map to bus `idle`, with
poll wake targets. Neither projection grants membership or authentication.
Direct messaging still requires the existing bus identities/aliases and channel
membership; the seat projection does not silently register them.

`phm bots message --from <seat> --to <seat|owner> --text <text>` reaches
`sendSeatMessage`: both ends accept a seat id or participantId, and `owner`
posts an owner-thread notice. `sendSeatMessage` sends to another configured
participant through the unified bus, or to the owner through the configured
owner thread (injected options win in tests). A seat-to-seat message resolves
the bus identity registry and appends under the same fleet root
(`<home>/.ashlr/fleet`) and clock the seat's claims and handoff notices use;
`runsRoot` places only the wake hint queue. Owner notices use the same
settings/runs construction as handoff notices and mirror onto that fleet root.
Unknown seats and secret-shaped text are refused. Provider adapter messaging
is separate.

The console's `/bots` Seats section reads `GET /api/bots/seats`: display name,
kind/provider, state, admission, quota evidence, current claims/jobs and recent
handoffs. Unknown readings have no numeric meter. There is no web apply route.

## Devin Bot API gap and spending boundary

The documented [Devin v3 OpenAPI](https://docs.devin.ai/v3-openapi.json) has
session messages/status, consumption and automations, but **no Bot endpoints**.
Bots are operated through the documented web/Slack/iMessage surfaces:
[Bots](https://docs.devin.ai/work-with-devin/bots) and
[usage limits](https://docs.devin.ai/work-with-devin/bots/usage-limits).
On Max, included Bot quota can roll into on-demand credits; the documented
product does not provide a per-Bot API usage limit.

Phantom therefore reports Bot status as unknown with
`no-documented-bot-messaging-api`; `message()` is advisory with the same reason
and documentation links. It never calls a Bot messaging endpoint or launches a
session. Without usage evidence it refuses `usage-evidence-missing`; exhausted
evidence refuses `quota-exhausted`. Even measured evidence permits only the
advisory response. The default message path makes no network call.

`usage()` reuses the existing documented organization-cycle consumption reader
(`readDevinUsage`, source `devin-api-v3-org-cycle`) in existing credential
custody. This is organization consumption, **not per-Bot quota**. Missing
credentials, unavailable readings or unknown limits remain unknown. The default
adapter must read usage explicitly before its cached evidence can be considered
by messaging. No adapter purchases credits, enables on-demand billing or spends
on a task. No quota reading authorizes paid/on-demand execution.
