# Agent app adapters

`phm agents apps` operates other agent apps from Phantom through one
provider-neutral interface, so the owner does not have to open them. Each
adapter declares five capabilities: launch a task, list sessions, read a
session's status and output, send a follow-up message, and read usage.

```sh
phm agents apps --json
phm agents apps codex-cli launch --prompt 'Fix the failing test' --model gpt-5.5 --cwd /abs/repo --json
phm agents apps codex-cli send THREAD_ID --prompt 'Now update the docs' --json
phm agents apps claude-desktop usage --window 'Usage' --json
```

| Id | Surface | Notes |
| --- | --- | --- |
| `codex-cli` | `codex exec --json -`, then `codex exec resume <thread> --json -` | Prompt on stdin. The thread id comes from `thread.started`. |
| `claude-cli` | `claude -p --output-format json`, then `--resume <session_id>` | Prompt on stdin. |
| `devin-cli` | Stub | Waits for the Devin ACP seat (`src/core/devin/acp-seat.ts`, #6550). Every capability is `unsupported`. |
| `<app>-desktop` | Desktop operator | For `devin`, `claude`, `codex`, `grok` and `cursor`. |

CLI adapters spend through each provider's own login; Phantom never reads
their credentials. KILL stops launch and send, and a failing KILL probe counts
as on. Sessions Phantom starts are recorded in `~/.ashlr/agent-apps/sessions.json`
(mode 0600), which serves `sessions` and `show`, because neither CLI documents a
machine-readable session list. Neither documents a usage command, so CLI
`usage` is `unsupported`; use the matching desktop adapter instead.

Desktop adapters call the [desktop operator](DESKTOP-OPERATOR.md) with all its
gates: Accessibility reads, a bus intent before `focus` and `type`, KILL and
comms pause, and the exact bundle-id write allowlist. `send` and `launch` type
into the focused composer; the operator has no submit key, so submit with
`phm desktop click`. Desktop adapters cannot pick a model or directory, and
their session ids are window titles.

Results are `{ok:true,value}` or `{ok:false,code,error}` (exit 0, 1; 2 for bad
arguments). App text is scrubbed, capped at 8,000 characters, `untrusted: true`.
