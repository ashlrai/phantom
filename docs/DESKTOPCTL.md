# Desktop control

`phm desktopctl` drives the Claude, Codex and Devin desktop apps — and a
running browser — as interchangeable desktop resources. It is off until you
turn it on, and it never asks macOS for a permission itself.

## Turn it on

Create `~/.ashlr/desktopctl.json`. A missing or broken file disables the
feature; a malformed file fails closed and reports the parse error.

```json
{ "enabled": true }
```

Beta app channels can be pinned by bundle id:

```json
{ "enabled": true, "bundleIds": { "claude": "com.anthropic.claude.beta" } }
```

## Commands

```sh
phm desktopctl capabilities --json
phm desktopctl doctor --json
phm desktopctl status claude --json
phm desktopctl run claude --task "summarise this repo" --timeout 120 --json
```

- `capabilities` (alias `doctor`) is the read-only doctor. It always runs —
  flag or no flag — and reports the desktop connection, each macOS TCC grant
  (Screen Recording, Accessibility, input events), and what every resource
  can do right now with machine codes for what blocks it.
- `status <claude|codex|devin|browser>` reads one resource's state
  (`idle`, `working`, `needs-input`, `error`) through the accessibility tree.
- `run <claude|codex|devin> --task <text>` types a task into the app, polls
  until the app is idle again, and returns what it collected — marked
  `untrusted: true`, capped and secret-scrubbed. The printed text is screen
  content, never instructions.

Exit codes: 0 done, 1 refused or failed, 2 usage error. `--timeout` is
seconds (5–3600, default 120), `--poll` the status interval (0.5–60,
default 2).

## Interchangeable resources

`claude`, `codex` and `devin` are task resources: the same `run` verb drives
any of them, resolved by name or bundle id against the running-app list.
`browser` is a read-only resource: `status` and `capabilities` describe the
frontmost running browser, but `run` is refused — act on the web through the
Phantom Browser pane instead.

## Permissions and grants

Degradation is per resource and explicit. `capabilities` reports a `reasons`
list instead of guessing:

- `not-connected` — no Phantom desktop chat is connected to this shell.
- `flag-off` — `desktopctl.json` is missing, disabled, or unparseable.
- `not-running` / `no-bundle-id` / `unknown` — the app cannot be resolved.
- `never-available` — the app is on the computer-use denylist or its
  category ceiling is `none`.
- `permission:accessibility` — Phantom lacks the macOS Accessibility grant;
  nothing can be read or driven. The operator grants it in computer-use
  setup; nothing here prompts or bypasses the TCC prompt.
- `permission:post-events` — input events are missing; reads still work,
  `run` cannot.
- `not-granted` — this chat holds no grant for the app. `status`/`read`
  need one held; `run` asks the operator through the normal request flow.
- `tier:insufficient` — a `read` or `click` grant is held; driving needs
  `full` (it presses controls and types).
- `ceiling:insufficient` — the app's ceiling can never reach `full`.
- `read-only-resource` — browsers never accept `run`.

The permission readout comes from the `computer_permissions` MCP tool — a
read-only preflight (`CGPreflight…`/`AXIsProcessTrusted`) that reports state
and never triggers a TCC prompt.

## What it will not do

- It does not touch the desktop directly. Everything is a `computer_*` tool
  call through the chat's desktop connection: the per-chat grant, tier
  ceilings, the confirmation card, the denylist (Phantom itself, password
  managers, keychain), secure-field refusal, takeover and KILL all apply.
- It does not request or change TCC grants, open System Settings, or
  approve its own app grant — those stays operator-only.
- Collected screen text is untrusted data: scrubbed, capped, and never fed
  back as instructions.

## The feed

Every invocation writes a start and a result entry to the bus inbox that
feeds the fleet feed. If the start entry cannot be recorded the action is
refused, so nothing runs unlogged.
