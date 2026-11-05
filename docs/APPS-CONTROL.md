# Apps control

`phm apps` lets Phantom open, quit, raise and check other desktop apps on your
Mac, but only the apps you name. It is off until you add some.

## Allow an app

Create `~/.ashlr/apps-allow.json`. A missing or empty file allows nothing.

```json
{ "apps": ["Notes", { "name": "Pages", "bundleId": "com.apple.iWork.Pages" }] }
```

An entry is an app name, a bundle id, or an object with both. Up to 64 entries.
The target you pass must equal an entry's name or bundle id (case-insensitive).

## Commands

```sh
phm apps list --json
phm apps status Notes --json
phm apps quit Notes --json
phm apps open com.apple.Notes --json
phm apps focus Notes --json
```

- `list` shows only the allowed apps and whether each is running.
- `status` says whether an allowed app is running and frontmost.
- `quit` presses the app's own Quit menu item.
- `open` and `focus` start or raise an app.

Without `--json` the same facts print as plain text.

Exit codes: 0 done, 1 refused or failed, 2 usage error, 3 sent to needs-you.

JSON result: `ok`, `action`, `app`, `outcome` (`done`, `refused`, `failed`,
`needs-you`), `code`, `detail`, `running`, `frontmost`, `logged`.

## What it will not do

- It acts on an app only if it is in the allowlist. Anything else is refused.
- It runs only through the desktop adapter (`src/core/verse/desktop-adapters.ts`),
  which speaks the `computer_*` tools. Your per-chat grant, tier ceilings, the
  confirmation card, the denylist (Phantom itself, password managers, the
  keychain), takeover and KILL all still apply.
- It does not type, press keys, or read what is inside an app. To decide whether
  a quit is safe it reads control labels and window titles only.
- It does not change TCC grants or touch the TCC helper.

## Unsaved work

Before quitting, Phantom looks for a Save or Don't Save button, a window titled
edited or unsaved, or an open sheet. If it finds one, or cannot read the app at
all, it does not quit. It adds an item to your needs-you list (`NEEDS-MASON.md`)
and exits 3. Save or discard in the app, then run the quit again. The check errs
toward asking you.

## The feed

Every action writes two entries to the bus inbox that feeds the fleet feed: one
before it runs and one with the result, including refusals. If the first entry
cannot be written the action does not run.

## Connection and launcher

Actions need a desktop connection (a Phantom desktop chat that holds the app
grant). From a plain shell there is none, so actions fail with "not connected"
and nothing happens. `list` still shows your allowlist with state unknown.

No `computer_*` tool starts or raises an app, so `open` and `focus` also need a
launcher supplied by the host. Without one they are refused as `unsupported`.
