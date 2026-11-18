# Owner Assist contract — RQ-DESK-OWNERASSIST-1, v2 RQ-OWNERASSIST-V2-1

Owner Assist reuses Verse while owning a separate store and one-turn admission
counter. This contract describes the exported TypeScript interfaces/functions and
native window bridge introduced with the surface. No new CLI command or runtime
dependency is introduced.

## Core exports

`src/core/owner-assist/types.ts` exports:

- `OwnerAssistPreferences`: `callsign: string`, `preference: auto | local | api`,
  optional integer `omlxPort` (1–65535).
- `OwnerAssistTurn`: `text`, `projectPath`, optional `extraRoots`, `sessionId`,
  `preference`, `seatId`, `model`; required `tier: fast | work | frontier`.
- `OwnerAssistRouting`: the transparency record for a send — `preference`,
  `tier`, selected `class: local | api`, `seatId`, `seatLabel`, `model`,
  `fellBack`, one-sentence `reason`, and ISO `at`. `fellBack` is true only when
  `auto` could not honor its first-choice class (explicit seat, `local` and
  `api` choices never fall back; they are refused).
- `OwnerAssistSnapshot`: `scope: owner`, `concurrency: 1`, preferences, Verse
  sessions/seats, memory text, optional `memorySanitized` flag, a `routing`
  record keyed by session id, and optional `resumeSessionId` — the persisted
  last-used conversation, present only when that session still exists.
- `OwnerAssistDetail`: Verse session, ordered Verse events, and pending terminal
  confirmations. Provider transport and launch records are never returned.
- `OwnerAssistTurnResponse`: `VerseTurnResponse` plus the `routing` record.
- `OwnerAssistHandoff`: `id: RQ-OWNER-<UUID>`, `repo`, `scope`, `acceptance`,
  `tier: fast | mid | work | frontier`, and optional `sessionId` — a UUID that
  must name an existing owner session.
- `OwnerAssistHandoffReceipt`: the handoff plus `fleetJobId`, optional recorded
  `prUrl`, `status: SUBMITTED | QUEUED | RUNNING | FINISHED | PR-OPEN | MERGED |
  REJECTED | UNOBSERVED`, and optional `sourceTitle`/`submittedAt` — the linked
  conversation's title (bounded to 200 characters) and ISO first-submit time.

`service.ts` exports `OwnerAssistService(root?, deps?)`. The default root is
`~/.ashlr`; dependency seams are an engine factory, seat discoverer, KILL reader,
and fleet runs root. Public methods are `snapshot(cfg)`, `configure(unknown)`,
`remember(unknown)`, `send(unknown, cfg, loopbackOrigin)`, `detail(id)`, `cancel(id)`,
`handoff(unknown)`, `handoffs()`, `findSession(id)` and `close()`. Async methods
return promises; detail/find/cancel/close are synchronous. `send` returns
`OwnerAssistTurnResponse`; configure returns validated preferences, remember
returns `{ok:true}`, cancel returns `{cancelled:boolean}`. Strict schemas bound
message/memory to 24,000 characters, project paths to 4096, extra roots to seven,
callsign to 60, scope to 8000 and acceptance to 2000. The existing fleet writer
further bounds the entire handoff prompt to 8000 bytes. Existing malformed state
is not silently replaced by reads. Admission stays reserved across asynchronous
checks. No provider launch happens on a validation or KILL refusal.

After a turn is dispatched the service persists `lastSessionId` plus the routing
record in `owner-assist.state.json` (mode 0600, at most 50 records kept by
decision time). That write is best-effort: a failure never fails an
already-dispatched turn, and a corrupt file is left untouched to surface on the
next snapshot read. `handoff` validates an optional `sessionId` against the
existing owner session detail and passes its title to the receipt store.

`routeOwnerTurn(discovery, turn, preferences)` is pure and returns
`{launch: VerseSeatLaunch, model: VerseModelOption, routing: OwnerAssistRouting}`.
Explicit choices refuse unavailable seats/models. Auto routing prefers local for
`fast` and the best available API seat for `work`/`frontier`, falling back
across classes with `fellBack: true` and an honest `reason`. It does not create
launches, reserve fleet capacity, provision inference, or retry on a paid
fallback after an explicit local selection fails.

`getOwnerAssist()` lazily owns the sidecar singleton. `findOwnerAssistSession(id)`
only searches an already-created instance; it cannot create runtime state during
MCP authentication. `closeOwnerAssist()` closes and clears it. The existing MCP
session lookup and terminal root lookup include this store. Existing grants and
single-command confirmation checks are unchanged.

`seats.ts` exports `discoverOwnerOmlx(port, fetchImpl?) -> Promise<VerseSeat[]>`
and `discoverOwnerSeats(cfg, port?) -> Promise<VerseSeatDiscovery>`. oMLX discovery
uses GET `/v1/models` on `127.0.0.1` only, refuses redirects, times out after 1500ms,
and caps the body at 128 KiB and 100 entries. Only validated Qwen chat ids with
`owned_by: omlx` are exposed. Unknown context size is null. Execution uses the
existing installed local harness; absence of that harness adds no runnable seat.

`handoffs.ts` exports `OwnerAssistHandoffs(root, runsRoot?)`, with async `submit`
and `list`. `submit(request, source?)` requires a service-validated handoff plus
an optional `{sessionId, title}` conversation link, records intent privately
before using `writeDropJob`, and refuses unsupported repositories. Receipt IDs
map deterministically to `RQ-PHX-OWNER<uppercase UUID without hyphens>`. Existing
IDs cannot change their task — including the linked session — and never
republish on retry. Receipt state is dispatch-neutral; only the drop is live
intake. `list` returns at most 30 receipts, using the existing 50-entry fate
projection, a 1 MiB metrics tail, and 64 KiB publication files, and projects
the stored `sessionId`, `sourceTitle` and `submittedAt` when present. It
returns no worker log contents. Missing evidence is UNOBSERVED; publication
URLs must name an ashlrai/phantom pull request. Reads never mutate fleet state
or infer merge from a PR URL.

## HTTP and UI exports

`createOwnerAssistApi(serviceFactory?) -> ApiModule` and the production
`handleOwnerAssistApi` live in `verse/owner-assist-api.ts`. Exact prefix routing
is `/api/verse/owner-assist`. All requests require a live read session; all POSTs
add the existing dispatch-enable and mutation-token gates. Query parameters are
refused. Bodies are JSON objects capped at 64 KiB; unknown fields are rejected.
Responses pass through the common public JSON scrubber.

| Method and suffix | Result |
| --- | --- |
| GET root | `OwnerAssistSnapshot` (includes `resumeSessionId`, `routing` map) |
| GET `/sessions/<uuid>` | `OwnerAssistDetail` |
| GET `/handoffs` | `OwnerAssistHandoffReceipt[]` |
| POST `/turns` | 202, `OwnerAssistTurnResponse` (adds `routing`) |
| POST `/preferences` | 200, validated preferences |
| POST `/memory` with `{text}` | 200, `{ok:true}` |
| POST `/sessions/<uuid>/cancel` with `{}` | 200, `{cancelled:boolean}` |
| POST `/handoffs` | 201, a submission receipt (including an existing retry) |

Errors use existing Verse status/code mappings, 400 for schema failures, 413 for
oversized bodies, and a scrubbed generic 503 for unexpected unavailable state.
The existing `/api/verse/agent-tools` confirmation endpoint accepts owner session
IDs but still requires its existing authority checks. Commands cannot approve
themselves by knowing a session ID.

The UI exports `ownerAssistApi` (typed HTTP client), `OwnerAssistApp` (auth/bootstrap)
and `OwnerAssistPanel({api?})` (injectable test seam). Model labels come from the
returned session and the transcript header adds the routing reason. The initial
selection is `resumeSessionId` when present, else the most recent session; the
unsent draft is kept in origin-local storage and cleared on a successful send or
handoff. A handoff links the selected session when one is open. Snapshot and
handoff refresh is every ten seconds; active transcript/approval refresh is
every 800ms. Requests do not overlap within a poller and abort on unmount. A
successful send clears the draft before follow-up reads, so a read failure does
not invite resubmitting an accepted turn.

## Native bridge

`owner_assist.rs` exports the `LABEL`, `MENU_ID` constants and `toggle(&AppHandle)`.
The remote webview reuses existing window-chrome/event/folder-picker permissions;
no shell or filesystem capability is added. Navigation is restricted to the
fixed numeric-loopback sidecar origin and exact Owner Assist path. Existing
startup/restart token handoff includes the new window.

`window.__ASHLR_OWNER_WINDOW__(pill | chat | fullscreen | hide)` emits the existing
Tauri event primitive with event name `owner-assist-window`. Rust accepts only
those four modes. It reports changes with DOM event `ashlr:owner-mode` and a mode
string as `detail`. No event parameter can name a command, file or executable.
The title strip uses the shell's existing drag-region adapter. Native geometry
is finite, bounded, privately persisted and checked against available monitors.
