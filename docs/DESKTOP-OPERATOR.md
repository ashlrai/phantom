# Desktop operator

Agents read visible sessions and act in Phantom, Devin Desktop, Codex, Claude, Grok Bot and Cursor on this Mac.

Baseline: apps readable through this UI path is 0. After `desktop-operator` is built and Accessibility is granted, the expected count is 6.

The helper is a small macOS binary. `phm` sends it one JSON request. It reads the accessibility tree first, then captures a window with CGWindow and reads that image with OCR when the tree has no text. Keyboard and mouse go through CGEvent. The Verse window path in `desktop/src-tauri/src/computer.rs` keeps ScreenCaptureKit, the HUD and per-chat grants. This command is the agent CLI beside that path.

Devin Desktop has no local-chat export. Claude, Codex, Cursor, Grok and Phantom are read the same way until a caller passes an official session export to `desktopSessions()`. The operator does not open app databases, the keychain, credential files or Messages `chat.db`.

## Commands

```sh
phm desktop doctor --json
phm desktop list-apps --json
phm desktop windows --app Cursor --json
phm desktop read --app Cursor --json
phm desktop screenshot --app Devin --json
phm desktop focus --app Claude --json
phm desktop scroll --app Codex --dy -3 --json
phm desktop type --app Cursor --text "hello" --json
phm desktop click --app Devin --x 100 --y 200 --json
```

`--json` prints one object. Exit 0 when `ok` is true, 1 when `ok` is false, 2 for usage. `phm desktop install` is unchanged.

MCP tools on the Phantom gateway use the same verbs: `desktop_list_apps`, `desktop_windows`, `desktop_read`, `desktop_screenshot`, `desktop_doctor`, `desktop_focus`, `desktop_scroll`, `desktop_type`, `desktop_click`. Read tools stay available while KILL is on. Write tools are refused while KILL is on.

## Permissions

Grant these once, to the `desktop-operator` binary (the file you built, usually `~/.ashlr/bin/desktop-operator`). The grant attaches to that binary, not to Terminal and not to `node`.

1. System Settings > Privacy & Security > Accessibility.
2. System Settings > Privacy & Security > Screen & System Audio Recording. On macOS before Sequoia the pane is named Screen Recording.

`phm desktop doctor --json` does not prompt. A missing grant returns `code: "permission_required"` with `pane`, `settingsUrl` and `binary`. Rebuilds change an ad-hoc signature, so approve the new binary after each rebuild until a stable Developer ID signature is applied by the sanctioned desktop publisher.

Build and ad-hoc sign on the Mac:

```sh
mkdir -p ~/.ashlr/bin
swiftc -O -framework ApplicationServices -framework Cocoa -framework Vision -o ~/.ashlr/bin/desktop-operator tools/desktop-operator/main.swift
codesign -s - --force ~/.ashlr/bin/desktop-operator
phm desktop doctor --json
```

`PHANTOM_DESKTOP_OPERATOR` may point at another absolute path. When that variable is set, no other path is tried.

## Writes

`list-apps`, `windows`, `read`, `screenshot` and `doctor` do not post to the bus. `focus`, `scroll`, `type` and `click` append a `desktop.intent` envelope through `appendBusInbox` and then act. The envelope records the verb, the app, the window title and a character count. It does not record the typed text. If the bus does not accept the envelope, the write does not run.

The fleet KILL switch and comms pause refuse those writes. Password managers, the keychain, Messages, System Settings and the custody helper stay closed. Writes are allowed only for the exact bundle ids of Devin, Codex, Claude, Grok Bot and Cursor. A display name or a missing bundle id does not unlock a write. Mail, Slack, Notes, browsers and Terminal stay read-only. Phantom stays read-only: agents drive it through `phm` and MCP, not by clicking its approval UI. The `computer_*` tools and `phm desktopctl` keep their own grants.

Screen text in CLI JSON and on the bus is passed through the secret-shape scrubber. Screenshot base64 stays in the CLI result. The MCP screenshot tool writes a mode 0600 PNG under `~/.ashlr/desktop-operator/shots/` and returns that path, because the gateway scrubber redacts long base64.

## Roster hook

Do not edit `src/core/fleet/agent-roster.ts` from this change. The roster reads:

```ts
import { desktopSessions } from '../desktop/desktop-sessions.js';
```

`desktopSessions()` returns `{ app, bundleId, windowTitle, sessionTitle, lastActivity, rosterApp }`. `lastActivity` is null for accessibility rows. Pass `sessionExports` when an app has an official read-only session list. Export rows for closed apps and forbidden stores are dropped.

## Verifier

On the Mac, after the binary is signed and the two panes are granted:

```sh
phm desktop doctor --json
phm desktop list-apps --json
```

`doctor` is ready when `ok` is true and `data.ready` is true. `data.accessibility.pane` and `data.screenRecording.pane` name the System Settings panes. `data.binary` is `desktop-operator`.
