# Apps control

The Phantom desktop Fleet Host pane's **Allowed apps** card and `phm apps` use
one typed app-control service. Enrollment is empty by default. Actions are
open, focus, quit and status; app-level requests can go to Needs you without
operating the desktop.

## Allow an app

Create `~/.ashlr/apps-allow.json`. A missing or empty file allows nothing.
Names, bundle ids and objects remain supported. At most 64 entries; names
and bundle ids must be unambiguous, case-insensitively. Invalid action policies
and unknown object fields fail closed.

This example is configuration to review and copy, not automatic enrollment:

```json
{
  "apps": [
    { "name": "Devin", "actions": ["open", "focus", "quit", "status"] },
    { "name": "Codex", "actions": ["open", "focus", "quit", "status"] },
    { "name": "Claude", "actions": ["open", "focus", "quit", "status"] },
    { "name": "Cursor", "actions": ["open", "focus", "quit", "status"] },
    { "name": "Grokbot", "actions": ["open", "focus", "quit", "status"] },
    { "name": "Messages", "actions": ["open", "focus", "status"], "mode": "request" },
    { "name": "Safari", "bundleId": "com.apple.Safari", "actions": ["open", "focus", "status"] },
    { "name": "Chrome", "bundleId": "com.google.Chrome", "actions": ["open", "focus", "status"] },
    { "name": "Phantom", "bundleId": "ai.ashlr.desktop", "actions": ["open", "focus", "quit", "status"] }
  ]
}
```

Use the app's actual installed name; optional `bundleId` pins its identity and
allows opening an app that is stopped. Names and ids are not guessed for Devin,
Codex, Claude, Cursor or Grokbot. Without a bundle id a stopped app cannot be
opened. Other browsers use the same explicit enrollment mechanism.

`actions` is an optional array drawn from `open`, `focus`, `quit`, `status`.
Omitting it preserves all four actions; an empty array permits none.
`mode` is `direct` by default or `request`. Request mode queues mutations for
review while status stays a read. Phantom always has effective request mode,
even if its entry says direct. This never removes Phantom from the desktop
screen-control denylist. The system denylist and tier ceilings still apply to
other apps regardless of enrollment. Browser read-only grants do not permit
pressing Quit; omit quit from their policy as above.

## Commands

```sh
phm apps list --json
phm apps status Cursor --json
phm apps open com.apple.Safari --json
phm apps focus Cursor --json
phm apps quit Cursor --json
phm apps request focus Cursor --json
phm apps request quit Phantom --json
phm comms status --json
phm fleet mission --json
phm fleet needs --json
```

Without `--json` the same facts print as text. Exit codes: 0 done, 1 refused
or failed, 2 usage error, 3 successfully recorded in Needs you.

The list returns `apps` with `name`, `bundleId`, effective `actions` and `mode`,
`running` and `frontmost` (null when unavailable), plus `connected` and `logged`.
Action reports contain `ok`, `action`, `app`, `outcome` (`done`, `refused`,
`failed`, `needs-you`), `code`, `detail`, `running`, `frontmost`, `logged`.
A failed needs-you write reports `needs-you-unavailable`, never a queued request.

## Typed desktop API

On the existing loopback server, GET `/api/verse/apps/control` returns the same
list; POST accepts exactly `{ "action": "focus", "app": "Cursor" }` or
`{ "action": "quit", "app": "Phantom", "request": true }`. Status is also a
POST action; reads do not execute app mutations. Unknown fields and malformed
requests return 400. POST requires dispatch enabled and the existing JSON
mutation-token gate. Both routes require a local peer and reject the mobile
channel. No new listener or authentication mechanism is added.

HTTP 200 means done, 202 means recorded in Needs you, 422 means refused or
failed, 503 means unavailable. The adapter uses its own console grant scope;
a caller cannot select another agent's session or borrow its grants. The
Allowed apps card displays only enrolled policy actions and disables controls
when its reading fails. The separate Managed apps recovery diagnostics use
the existing fixed-catalog host-script API; their inventory does not enroll
apps in this allowlist.

## Unsaved work and limits

Quit reads control labels and window titles for Save/Don't Save controls,
edited/unsaved titles or an open sheet. A positive signal, unreadable, empty
or truncated tree blocks quitting and records a Needs you item. No field values
or app contents are returned by apps control. Save or discard in the app,
then retry through the same policy checks. The adapter presses only the app's
own Quit menu item, never a discard or save confirmation.

Every operation writes feed intent and result entries, including refusals.
If intent cannot be recorded, no action runs. KILL and comms pause block app
mutations. Actions retain the desktop adapter's per-chat grants, tier ceilings,
confirmation cards, takeover and native KILL enforcement. No typing,
keystrokes, message reads or TCC changes are added.

Open/focus need the host LaunchServices launcher. An unconnected macOS shell
can open an explicitly allowlisted bundle id with `/usr/bin/open -b`. A
connected desktop that refuses its app listing cannot use that fallback.
Status/focus/quit otherwise need a desktop connection; list preserves unknown
state when disconnected. The API uses the existing desktop relay and refuses
when it is unavailable.

## Fleet jobs and Phantom self-control

A fleet job can run `phm apps request focus Cursor --json` rather than operate
an app. Allowlist and action policy are checked before queuing. A request-only
entry also turns ordinary mutation commands into requests. No desktop or
launcher calls run for either case.

The request appends to `NEEDS-MASON.md`, which the existing Fleet inbox and
`phm fleet needs --json` read. The existing resolve path records the owner's
reply on Agent Bus. The job reads that reply and decides its next step under
current policy; neither a request nor resolution automatically executes an
action or grants a transport. Unsafe quits must be retried only after unsaved
work is handled. Phantom lifecycle requests stay request-only; its own session
work runs through the existing typed session API, not screen control. Outbound
messages still use the separate drafts flow and its send policy. An app request
is never send authority.
