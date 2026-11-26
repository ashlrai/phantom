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
swiftc -O -target arm64-apple-macos13.0 -framework ApplicationServices -framework Cocoa -framework Vision -o ~/.ashlr/bin/desktop-operator tools/desktop-operator/main.swift
codesign -s - --force ~/.ashlr/bin/desktop-operator
phm desktop doctor --json
```

The helper is loaded only from `~/.ashlr/bin/desktop-operator`.

The `-target` flag is required: the macOS 15 SDK marks `CGWindowListCreateImage` unavailable for newer deployment targets, and the helper still uses it for single-window capture.

## Which window is read

When a call names an app and no window title, the helper uses that app's largest window. Windows shorter than 64pt are title-bar and toolbar strips: a native-fullscreen app, and any app with an overlay title bar, owns several that are as wide as the screen and about 30pt tall. They are left out of `windows` and are never picked for `read` or `screenshot` while a larger window exists. Before this rule a fullscreen Phantom was captured as a 1280x21 sliver and looked like an empty app.

If only strips are on screen, the app is fullscreen on another Space; the helper then looks for the content window across all Spaces. `windows` rows carry `width` and `height` in points.

`read` falls back to OCR when the accessibility tree has no labelled node below the window. A webview that has not published its tree walks as `AXWindow` plus an empty `AXGroup`; that is structure, not the app's text. `source` is `ocr` in that case.

`echo '{"op":"self-test"}' | ~/.ashlr/bin/desktop-operator` runs the window-selection checks. It needs no grant and touches no app.

## Writes

`list-apps`, `windows`, `read`, `screenshot` and `doctor` do not post to the bus. `focus`, `scroll`, `type` and `click` append a `desktop.intent` envelope through `appendBusInbox` and then act. The envelope records the verb, the app, the window title and a character count. It does not record the typed text. If the bus does not accept the envelope, the write does not run.

The fleet KILL switch and comms pause refuse those writes. Password managers, the keychain, Messages, System Settings and the custody helper stay closed. Writes are allowed only for the exact bundle ids of Phantom (`ai.ashlr.desktop`), Devin, Codex, Claude, Grok Bot and Cursor. A display name or a missing bundle id does not unlock a write. Mail, Slack, Notes, browsers and Terminal stay read-only. For Phantom itself, prefer the self-surface below: it works when the window is hidden and targets stable ids instead of pixels. The `computer_*` tools and `phm desktopctl` keep their own grants.

Screen text in CLI JSON and on the bus is passed through the secret-shape scrubber. Screenshots are local-only by default because pixels cannot be scrubbed. `phm desktop screenshot` and the MCP `desktop_screenshot` tool write a mode 0600 PNG under `~/.ashlr/desktop-operator/shots/` and return its path, metadata and scrubbed OCR text, never image bytes. No bus message, MCP result or export carries the image unless that call sets `--include-image` (CLI) or `include_image: true` (MCP).

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

## Self-surface

Phantom can see and drive its own window without screen pixels. The console publishes a loopback URL and a scoped token, mode 0600, at `~/.ashlr/self-surface/endpoint.json`. The token opens only `POST /api/verse/self/request`. It is not the console mutation token, and browser origins are refused. The desktop webview long-polls for requests, runs them in the page and posts the result back, so a hidden or minimized window still answers.

```sh
phm desktop self snapshot --json
phm desktop self screenshot --json
phm desktop self navigate --section settings --json
phm desktop self act --test-id fleet --json
phm desktop self check --json
```

MCP tools on the Phantom gateway: `self_snapshot`, `self_screenshot`, `self_navigate`, `self_act` and `self_check`.

- `snapshot` returns the current route, document title, viewport, overflow, node count, recent console errors, and a bounded list of landmarks, headings and controls. Each entry has its role, name and stable id (`data-testid`, `data-section`, `data-verse-anchor` or `data-settings-group`). Input values are never read.
- `screenshot` renders the webview's DOM to a PNG, written mode 0600 under `~/.ashlr/self-surface/shots/`. The call returns its path. Image bytes come back only with `--include-image` (MCP `include_image: true`). The render comes from the DOM, so external images and fonts can be missing.
- `navigate` opens a section. `act` clicks or focuses the element with that stable id; password fields are refused.
- `check` opens each main screen, then snapshots and captures it. It waits for skeletons and busy regions to clear (6 s cap), then flags console errors, loads over 2 s, a screen still loading, horizontal overflow, an empty screen, and node-count or height changes over 40% against `~/.ashlr/self-surface/baseline.json`. `--update-baseline` records the current run. Run it after each release.

Every request posts a `desktop.intent` envelope (verb `self-<verb>`) to the bus first. If the bus refuses the envelope, the request does not run. `navigate` and `act` are refused while KILL or the comms pause is on; reads stay available. Result text passes the secret-shape scrubber.
