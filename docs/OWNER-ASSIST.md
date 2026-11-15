# Owner Assist

Owner Assist is the personal agent window in Phantom's menu bar. Choose **Owner
Assist** to show or hide it. Drag the title strip, resize the chat, collapse it
to a pill, or expand it to fullscreen. The window stays above other windows;
summoning it does not explicitly activate the app or move keyboard focus. Closing
it hides it while its current turn continues. Position and chat size survive
restart; a disconnected monitor sends the window back to a visible display.

The implementation uses Phantom's shipping **Tauri** desktop shell. There is no
Electron runtime in this repository, and this feature introduces neither a
second desktop framework nor a runtime dependency. The standalone web route is
`/verse/owner-assist/`; browser use keeps the chat and mode controls but cannot
float above other applications.

## Work on a project

Choose **Open project**, or enter an absolute project directory. Attach additional
folders to grant project context, or attach a small text file to the message.
Existing protected-path and symlink checks apply. Personal projects do not need
fleet enrollment. Choose a model and task difficulty, then send a request.

This is the existing Verse session engine, with native editing tools, persistent
transcripts, cancellation, checkpoints, provider permissions, local-only policy,
and Phantom's terminal MCP bridge. Shell, `gh`, memory and configured Phantom
comms commands are available through that bridge; its pending commands appear
inline with **Allow once** and **Deny**. These approvals authorize the displayed
command only. Native provider tools retain the workbench's default permissions;
Owner Assist does not turn on bypass mode. Outbound communications retain their
own draft/send policy. Browser and computer grants remain off. No additional
companion MCP credentials are copied into the window.

The header shows activity and each conversation identifies its model. **Stop**
cancels the active personal turn. Conversation selection restores the project
and additional roots. Switching a model or project starts a new native session
with the previous conversation's last 12,000 characters as context. Selecting
**New chat** starts without that transcript. Turn admission is limited to one
personal turn, including while filesystem and seat checks are in progress.

## Models and identity

**Auto** prefers a local model for Quick and Build / iterate tasks and an existing
API/subscription seat for Hard / architecture tasks. **Local only** never falls
back to a paid provider. A specific seat/model choice is checked again at send
time and is refused if unavailable. Existing account capacity and policy checks
still apply; personal concurrency does not reserve provider quota.

The model list includes the workbench's configured tool-capable local runtime
(including its llama.cpp route) and available Claude/Codex seats. Owner Assist
also reads bounded oMLX metadata at numeric loopback, default port 8000. It offers
advertised Qwen chat models supported by the existing Claude tool harness and
prefers advertised 27B+ models. Configure the port in **Memory & identity**. It
does not provision models, start an inference server, guess credentials or route
a local model to a remote address. A protected or unavailable oMLX endpoint is
omitted. Tool quality depends on the provisioned model/template. Grok and Devin
are omitted because their current runtime integrations are not compatible with
this isolated owner store.

**Memory & identity** saves the callsign, default model preference, and a shared
markdown memory of decisions, projects and preferences. New native sessions
receive that identity and instructions to maintain memory without secrets.
The editor refuses credential-shaped input and refuses replacing original
memory with additional redaction placeholders. Responses scrub secrets and
shorten the current user's home path. **Unlock actions** restores an expired
mutation-token hold; desktop startup and sidecar restart use the existing private
token handoff.

## Hand off to the fleet

Choose **Hand off to fleet**, enter acceptance criteria, and explicitly submit the
message. The installed drop intake currently supports **ashlrai/phantom only**;
other repositories are refused rather than placed into a dispatch-neutral queue.
The existing writer publishes one `RQ-PHX-OWNER…` prompt with a valid tier and
`codex-personal` as the routing hint. The normal fleet router chooses capacity.
Intake size, protected-content and queue-depth checks apply. Owner Assist never
edits `ready.tsv`, installs dispatchers, or starts a fleet worker itself.

The widget polls owned receipts and existing fleet evidence. SUBMITTED means
the drop was written, QUEUED means ingestion was observed, and a PR link appears
only after a recorded publication. MERGED requires explicit merge evidence.
FINISHED does not claim success. REJECTED and UNOBSERVED remain visible. Missing
or aged-out evidence never becomes completion, and retrying the same submission
id never creates another job, even after evidence disappears. Review an
UNOBSERVED attempt before submitting a new task. The most recent 30 handoffs are
shown; the bounded metrics window can omit older observations.

Ordinary chat turns use no fleet jobs, lane slots, ready rows or handoff receipts.
Explicit handoff is the bridge into the workforce. Personal and fleet work may
still share physical CPU/GPU resources and provider account quotas.

## Local state and development

| Path under `~/.ashlr` | Purpose |
| --- | --- |
| `owner-assist.json` | Callsign, preference, optional oMLX port |
| `owner-assist.sessions/` | Isolated Verse sessions and process registry |
| `owner-assist.memory/memory.md` | Persistent assistant memory |
| `owner-assist.handoffs/` | Private submission receipts; not a scheduler |
| `owner-assist.window.json` | Native chat geometry |

New config, memory and geometry files use mode 0600. Ordinary console sessions
remain in their existing store. Sidecar shutdown closes both engines. The fleet
KILL switch blocks new personal turns and new handoffs; running turns retain the
runtime's existing cancellation behavior.

There is no new CLI verb. HTTP endpoints return JSON and use the existing read
session, dispatch-enable and mutation-token boundaries; see the
[exported-signature contract](contracts/CONTRACT-OWNER-ASSIST.md). Regression
coverage lives in `test/owner-assist.test.ts`,
`test/static-phantom-aliases.test.ts`, the adjacent web component test, and the
native `owner_assist::tests` module. Development needs the usual desktop packaging
assets for a complete app build; compile-only checks can omit those bundle assets.

Upstream implementation references: [Tauri window builder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html)
and [oMLX's model and Anthropic endpoints](https://github.com/jundot/omlx).
