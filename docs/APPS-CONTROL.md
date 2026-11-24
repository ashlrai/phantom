# Apps control

## Known apps

`phm apps` lists the apps Phantom knows by name: Phantom, Claude, Codex,
ChatGPT, Cursor, Grok, Devin and Safari (Phantom's own agent browser). Each row
says whether the app is installed, running and in front, its pid, and how much
memory it and its helpers hold. `phm apps status` with no name is the same list. Anything Phantom cannot read says `unknown`, with the
reason. The Fleet Host **Apps** card shows the same report with one button per
row: Open, or Bring to front.

```sh
phm apps
phm apps --json
phm apps open claude --json
phm apps focus cursor --json
phm apps suggest --pressure warning --json
```

`open` starts or raises an installed app. `focus` raises a running app and
never starts one. Both are logged to the feed and stop under KILL or a comms
pause; Phantom itself still goes to Needs you. Phantom never quits your apps:
`phm apps quit` refuses every known app except Safari with code `protected`,
whatever `apps-allow.json` says, and refuses Chrome (your own browser) the same
way. An `apps-allow.json` entry for a known app narrows what it allows.

Quitting reads the app through Accessibility to check for unsaved work. When
that grant is missing, the answer is `outcome: "needs_permission"` with
`permission.settingsPath`: turn Phantom on in System Settings > Privacy &
Security > Accessibility, then try again. Nothing is pressed.

`phm apps suggest [--pressure normal|warning|critical] [--need-mb <n>]` lists
the idle apps (running, not in front) that would free the most memory, biggest
first; with `--need-mb` it stops at the fewest that cover it. It is read-only
and never quits anything. Rows for your own apps carry `command: null`: close
those yourself. JSON is `schema: "phm.apps.suggest/1"`.

`phm apps restart <app>` quits an app and opens it again, under every quit
rule above. Quit and restart also refuse the app in front (code `focused`):
that is the one you are using. After pressing Quit, Phantom watches for up to
10 s; if the app has not closed, the answer is `outcome: "unknown"` with code
`quit-timeout`, and a restart does not reopen it.

Add `--dry-run` to open, focus, quit or restart to check every rule without
acting: the answer is `outcome: "dry-run"` with `commands`, the exact steps a
real run would take. Nothing is run and nothing is logged.

```sh
phm apps restart safari --dry-run
phm apps open cursor --dry-run --json
```

Each row also carries `kind` (`agent-app`, `browser`, `ide` or `phantom`),
`processName` (the running main executable, or null) and `lastAction` (the
latest open, focus, quit or restart in the feed, or null). Action answers are
`schema: "phm.apps.action/1"`; the allowlist is `schema: "phm.apps.allowed/1"`.

The report reads the filesystem, `plutil`, `ps` and `lsappinfo` only. It needs
no Accessibility or Automation permission and never launches anything. Apps
are matched by their `.app` path, not bundle id. JSON (`schema: "phm.apps/2"`)
has one row per app in a fixed order; GET `/api/verse/apps/mac` returns it.
Every `phm apps` JSON answer carries `version: 1`; new fields are additive. The
`phm.apps` report is at `version: 2`: each row adds `lastFocusedAt` (ISO time) and
`lastFocus` (`known`, `never` or `unknown`), read for running apps with
`lsappinfo`. A missing `lsappinfo`, an unreadable line or a stopped app is
`unknown`, never 0 or now; the card and `phm apps` show it as "Last used".

## Action log

`phm apps log` lists what Phantom did to your apps: every open, focus, quit
and restart on record in the feed, newest first, each with its outcome and the
reason that was logged. Refusals are in the list too. The Fleet Host **App
actions** card shows the same list in plain sentences; **Needs a look** keeps
only the actions that were refused, failed, are waiting on you or have no
known result. The card reads only: it has no button that acts on an app.

```sh
phm apps log
phm apps log --limit 200 --json
```

JSON is `schema: "phm.apps.actions/1"`: `actions` (each with `at`, `action`,
`app`, `outcome`, `detail`), `total`, `counts` by outcome, `lookups`, `source`,
`skipped` and `truncated`. It lists 50 actions unless `--limit` asks for more,
at most 200. GET `/api/verse/apps/actions` (optional `?limit=`) returns the
same report to a local peer and writes nothing.

The log adds no record of its own. It reads the two feed lines every
operation already writes, the intent and the result:

- An intent with no result line is `outcome: "no-result"`. Phantom does not
  guess how it ended.
- A feed that cannot be read gives `source: "unavailable"` with `total: null`,
  and `phm apps log` exits 1. That is unknown, not zero.
- `list` and `status` only read, so they are counted in `lookups` and not
  listed. Dry runs are never logged.
- The feed keeps a line for up to seven days, so older actions are not shown.
- Agent browser actions (`phm browser`) are logged separately and are not in
  this list.

## Browser (Safari)

Safari is Phantom's own agent browser. `phm browser` drives it and nothing
else: Chrome, by name, address or profile path, is always refused.

```sh
phm browser --json
phm browser doctor --json
phm browser open https://example.com/ --json
phm browser shot page.png --json
phm browser close --json
```

`phm browser` (or `tabs`) lists the open agent tabs and the latest screenshot.
`open` loads an http or https address in a new tab. `shot` saves a picture of
the front Safari window and keeps a copy for the Browser card. `close` closes
every Safari window without quitting Safari. `doctor` says whether Safari
remote automation is on and the one step to turn it on (Safari > Settings >
Developer > Allow remote automation); Phantom never changes that setting.
Anything it cannot read says unknown.

Every answer is `schema: "phm.browser/1"` with `version: 1`, `ok`, `outcome`
(`done`, `refused`, `failed`, `needs_permission`), `code` and `detail`; new
fields are additive. Exit 0 done, 1 refused or failed, 2 usage. The Fleet Host
**Browser** card uses the same service: GET `/api/verse/apps/browser` (tabs),
GET `/api/verse/apps/browser/doctor`, GET `/api/verse/apps/browser/shot`
(latest screenshot) and POST `/api/verse/apps/browser` with
`{ "action": "open" | "shot" | "close", "url"? }`. The API takes no file path.
`open`, `shot` and `close` are logged to the feed; KILL and comms pause block
`open` and `close`. Phantom never reads cookies or saved passwords.

## Allowed apps

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
phm apps quit Notes --json
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
