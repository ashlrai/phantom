<a id="remote-agent-transport-330"></a>

# Remote agent transport: watching and steering the fleet

How an integrator's agent — a mobile remote or an agent-native client — uses
the existing authenticated remote transport to read fleet state and issue
pause/resume/Stop. Everything below already exists on `master`:
`createRemoteFleetFeed` and `RemoteFleetTransport`
([source](../src/core/web/remote-fleet-feed.ts)) against the opt-in phone
gateway ([source](../src/core/web/remote-gateway.ts)) and its route policy
([source](../src/core/web/remote-gateway-policy.ts)). No new endpoints.
Executable proof: [test/phx-remote-agent-recipe-31ac0.test.ts](../test/phx-remote-agent-recipe-31ac0.test.ts).

## Gateway URL vs loopback endpoints — never interchangeable

There are two HTTP servers on the Mac, and a remote client may speak to only one:

- **Hub (loopback only)** — `http://127.0.0.1:7777`, the desktop's local
  server. Its GETs take the local read token, its mutations the separate local
  mutation token, both in `X-Ashlr-Token`. Those credentials are server-side
  secrets: they exist to carry the gateway's own loopback hop to Hub, and a
  remote client must never possess, send, or log them. The gateway's envelope
  check rejects any remote request that bears `x-ashlr-token` or
  `x-ashlr-read-client` before routing.
- **Remote gateway** — the only door for remote clients. It binds loopback
  (`http://127.0.0.1:<gatewayPort>`) and is published exclusively as the
  configured `access.publicOrigin` (for example `https://phone.example.com`)
  through Cloudflare Tunnel fronted by Cloudflare Access. A remote agent calls
  the **public origin**; a same-Mac integration may call the gateway's own
  loopback port. It must never call the Hub port.

`RemoteFleetTransport` is implemented against the gateway only:

```ts
interface RemoteFleetTransport {
  get<T>(path: string): Promise<T>;                      // GET `${gateway}${path}`
  mutate<T>(method: 'POST', path: string, body: unknown): Promise<T>;
}
```

The feed adds nothing of its own: no headers, credentials, retries, fallbacks,
or alternate routes. Every gateway rejection reaches the caller as a rejected
promise; a transport must not swallow or reclassify it.

## What every gateway request must carry

- A Cloudflare Access assertion for an `allowedSubjects` identity (the
  `cf-access-jwt-assertion` header or the Access session cookie).
- A live device session cookie (`__Host-ashlr-remote`) obtained from
  `POST /remote/auth/finish` after a WebAuthn passkey login. Sessions are
  short-lived; `GET /remote/session` reports `authenticated`, `deviceId`,
  `scopes`, `csrfToken`, `expiresAt`, and `capabilities`.
- `host` equal to the `publicOrigin` host and `origin` equal to `publicOrigin`
  (`sec-fetch-site: same-origin` when the client sets it).
- `x-ashlr-remote-csrf: <csrfToken>` on every POST — the token returned by
  `/remote/session` or the auth finish response.

## Reads — reviewed GET routes only

Each feed method issues exactly one GET on a route the gateway policy lists
individually; there is no general `/api/*` proxy. `classifyRemoteRoute` must
return `{ kind: 'read' }` or the request is refused with `ROUTE_DENIED`.

| Feed call | Request | Response type |
| --- | --- | --- |
| `feed.list()` | `GET /api/verse/fleet/live` | `FleetLiveSnapshotV1` |
| `feed.runs()` | `GET /api/verse/fleet/runs` | `FleetRunsV1` |
| `feed.laneTargets()` | `GET /api/verse/fleet/control/lanes` | `LaneTargetsV1` |
| `feed.switches()` | `GET /api/verse/fleet/control/switches` | `RunsSwitchesV1` |
| `feed.inbox({ limit?, source? })` | `GET /api/verse/fleet/runs/inbox?limit=N[&source=S]` | `FleetInboxReadV1 \| null` |
| `feed.queue({ limit? })` | `GET /api/verse/fleet/live/queue[?limit=N]` | `FleetQueueV1` |
| `feed.bus({ limit? })` | `GET /api/verse/fleet/live/bus[?limit=N]` | `FleetBusFeedV1` |

Option contract (validated locally before any request): `limit` is an integer
from 1 to 200 (inbox defaults to 50 and always sends `limit`); `source` matches
`^[A-Za-z0-9 ._-]{1,40}$` and is URL-encoded. Unknown option keys throw.

## Mutations — pause, resume, Stop

| Feed call | Request | Meaning |
| --- | --- | --- |
| `feed.pause()` | `POST /api/verse/daemon` `{ "action": "pause" }` | Set the daemon pause sentinel: running jobs finish, nothing new dispatches. |
| `feed.resume()` | `POST /api/verse/daemon` `{ "action": "resume" }` | Clear only the pause sentinel. **Resume never clears Stop and grants no new authority.** |
| `feed.kill()` | `POST /api/verse/authority` `{ "action": "stop" }` | Engage the global Stop. Clearing Stop is a deliberate owner act, not something `resume()` does for you. |

All three classify as writes requiring **step-up**: a direct POST is answered
`403 STEP_UP_REQUIRED`. A transport completes the mutation through the
existing ceremony, which binds one WebAuthn assertion to the operation's exact
bytes:

1. `POST /remote/step-up/begin` with `{ "method": "POST", "path": path, "body": JSON.stringify(body) }` → `{ challengeId, options }`.
2. The paired device's passkey signs `options` (user verification required).
3. `POST /remote/step-up/finish` with `{ method, path, body, challengeId, response }` → the gateway re-verifies pairing, act scope, and the bound body, forwards the mutation to Hub over loopback, and returns the result (204 or JSON).

One assertion authorizes one operation once — approving `pause` does not cover
`resume`, and a consumed challenge cannot be replayed. Never try to skip
step-up, and never try to "fix" a `STEP_UP_REQUIRED` by switching credentials;
prompt for the passkey instead.

## Pairing ownership — who may do what, and from where

`createRemotePairing` ([source](../src/core/web/remote-pairing.ts)) splits the
ceremony into a **`mac` facade** and a **`phone` facade**:

- **Mac-owned** (`invite`, `pending`, `approve`, `deny`, `revoke`) is reachable
  only through the private Mac-local operator socket — the
  `phm verse remote invite <Access-subject> [read|act]`,
  `pending`, `devices`, `approve <id>`, `deny <id>`, `revoke <id>` commands.
  No remote HTTP route performs approval or revocation.
- **Phone-reachable** — `POST /remote/pair/claim` (one-use code + label),
  `POST /remote/pair/complete` (registration response), and
  `GET /remote/pair/status?pendingId=<id>` are bound to the preauth session
  that claimed the code; another session cannot observe or finish the
  registration. `POST /remote/auth/begin` / `/remote/auth/finish` then logs the
  paired device in and issues the device session.
- **Scopes** — every device has `read: true`; `act` is granted only by an
  `invite ... act`. A read-scoped device gets `403 ACT_DENIED` on any write.

## Device revocation

`phm verse remote revoke <device-id>` marks the device in the durable
registry; the gateway drops its sessions and open streams immediately, and the
device store is re-read per request, so the next read or write fails with
`401 DEVICE_SESSION_REQUIRED` (`GET /remote/session` reports
`DEVICE_REVOKED`). A transport surfaces the 401 and stops — it must not retry,
re-pair, or fall back to another credential on its own.

## Errors the caller can receive

`ACCESS_REQUIRED` (401), `DEVICE_SESSION_REQUIRED` (401), `DEVICE_REVOKED`
(401/403), `ACT_DENIED` (403), `STEP_UP_REQUIRED` (403),
`REMOTE_ENVELOPE_DENIED` (403; host/origin/CSRF mismatch or a local Hub token
on the request), `ROUTE_DENIED` (404; unlisted path or stream route),
`INVALID_MUTATION` (400; body failed the reviewed shape),
`HUB_UNAVAILABLE`/`HUB_BAD_RESPONSE`/`HUB_READ_UNAVAILABLE` (502/503),
`PREAUTH_REQUIRED`/`PAIRING_DENIED`/`PAIRING_NOT_FOUND` (401/403/404).

## Never do

- Never send `X-Ashlr-Token`, `x-ashlr-read-client`, or any loopback Hub
  credential on a remote request — it is refused outright and indicates the
  token has already escaped.
- Never point a remote transport at `http://127.0.0.1:7777` or Tunnel directly
  at the Hub port; Tunnel targets the gateway port only.
- Never bypass or auto-satisfy step-up, cache an assertion for a different
  operation, or treat `resume()` as a Stop-clear.
- Never invent paths or query shapes — the gateway reviews each one
  individually and denies everything else.
