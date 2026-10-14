# Phantom as the shared surface for Codex and Claude

Phantom can become the place users plan, supervise and review work across Codex
and Claude while each provider retains its native execution engine. The strongest
path combines structured backend sessions, desktop handoff and scoped plugins.
Computer use extends the remaining app workflows.

**Status: research and proposed architecture, observed October 13, 2026.**
This document does not establish new app-control functionality, active background
integration, provider commissioning or runtime acceptance. No desktop sessions
were started, resumed, messaged, interrupted or changed during this research.

## Evidence and confidence

Repository inspected: `ashlr-hub`, support worktree
`/Users/masonwyatt/.codex/worktrees/phantom-autonomy-docs-support/ashlr-hub`.
Branch: `codex/phantom-autonomy-support-20261013`.
Starting HEAD: `37900cb15b0b07f4f6e81b2eb7f1e99d02d13c05`, Phantom 3.29.15.
The checkout contained concurrent support changes; it was **dirty**, not a new
qualified release. Source links below describe inspected implementation.

| Evidence | What it establishes | Confidence and remaining gap |
| --- | --- | --- |
| Official documentation, opened during research | Documented protocols and product limitations | Strong for the documented interface; feature availability and installed-version behavior still require qualification |
| Installed CLI `--version` and `--help` | Local binary version and advertised commands | No session execution, account access or provider acceptance exercised |
| App bundle plist and packaged runtime metadata | Installed app identity/version and registered URL schemes | No desktop controller connection or app workflow exercised |
| Phantom source inspection | Existing adapter, storage, grants and computer relay patterns | Source presence does not prove enabled installed-product functionality |

## Observed local toolchains

| Surface | Observed identity | Consequence |
| --- | --- | --- |
| PATH Codex CLI | `/opt/homebrew/bin/codex`, `0.136.0` | Advertises app-server stdio/Unix-socket/WebSocket transports, daemon management and control-socket proxy |
| Codex desktop app | `/Applications/ChatGPT.app`, bundle `com.openai.codex`, version `26.1007.30912`, build `20156` | Actual installed bundle name differs from the Codex product name; registered scheme includes `codex` |
| Codex app-packaged runtime | `Contents/Resources/codex-cli/codex-package.json`, version `0.162.0-alpha.17.2` | Metadata observation only; do not assume this matches PATH Codex or its protocol schema |
| PATH Claude Code | `/Users/masonwyatt/.local/bin/claude`, `2.1.280` | Help advertises background sessions, JSON session listing and resumable streamed CLI turns |
| Claude desktop app | `/Applications/Claude.app`, bundle `com.anthropic.claudefordesktop`, version `2.37337.1` | Registered scheme includes `claude`; app version does not establish embedded Code engine version |

The Codex package directory contains `CodexCLI.app`, `bin`, `codex-path` and
runtime resources. Discover the exact executable through package metadata and
validate its identity/version before selecting it. Never change signing,
executable permissions or application resources to force a connection.

A bounded metadata search of selected default Codex application directories
found no control socket. This is **not** proof that the running desktop app has
no endpoint: its actual endpoint, ownership, authentication and attachment
semantics remain unverified. No socket was connected during research.

## Supported integration paths

### Codex: structured sessions and a rich client adapter

[Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes embedding Codex in another product through bidirectional JSON-RPC.
It supports thread listing/reading, start/resume/fork, streamed turn events,
steering, interruption and approval requests. Stdio is the default; Unix sockets
are also documented. The app-server command and WebSocket transport carry
experimental/production-support limitations. Generate schemas from the exact
selected binary and gate experimental methods explicitly.

Use `thread/read` for observation; `thread/resume` loads a session and changes
its live lifecycle. Record returned native thread/session IDs rather than
deriving them. A successful request is distinct from a completed turn.

[The Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) is the documented route
for programmatic jobs, with persisted thread continuation/resume. This supports
a Phantom-owned backend independent of any desktop window. Sharing ownership
of a currently running desktop session still needs a separately qualified
attachment and concurrency contract.

### Claude Code: backend control and supported background observation

[Programmatic Claude Code](https://code.claude.com/docs/en/headless) provides
CLI/SDK execution, structured results and streamed JSON. Persistent session IDs
support [resume and fork](https://code.claude.com/docs/en/agent-sdk/sessions).
Retain bounded permission callbacks, budgets and terminal result handling.

[Agent view](https://code.claude.com/docs/en/agent-view) documents external
supervisors using `claude agents --json --all`. Entries expose identity,
directory, state, live status and waiting reason. The provider's supervisor
keeps background sessions running without an attached terminal; shutdown still
stops running work. Agent view is a research preview. Prefer this supported
listing over parsing private job-state files.

The [CLI reference](https://code.claude.com/docs/en/cli-reference) documents
background launch, attach, logs and stop. Verify each command against the
selected installed version; `--bg` and print mode are separate execution paths.
The currently installed help advertises background launch and JSON listing,
but no background task was launched or enumerated here.

### Desktop handoff and plugins

[Claude Code Desktop](https://code.claude.com/docs/en/desktop) runs the same
underlying Code engine and shares project memory, hooks and MCP configuration.
Its graphical surface is interactive; print/output-format flags have no desktop
equivalent. Idle terminal sessions can move into Desktop with their conversation.
The documented `claude --desktop --resume <session-id>` requires CLI 2.1.285+;
the observed PATH CLI 2.1.280 cannot be assumed to support it. An active terminal
or background session cannot simply be moved into Desktop.

[Claude deep links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
can open chat, Code or Cowork and prefill a prompt. Prefill is not submission;
folder links require confirmation. These provide review/navigation handoff,
not an authenticated unattended command channel.

An agent-native Phantom plugin can expose scoped tasks, evidence and workflow
tools to the agent running inside either native app. That direction is
**native agent calls Phantom**. It does not automatically grant Phantom an
external API to operate every native app conversation. Codex's session-management
tools visible inside this development chat likewise do not establish a callable
external controller for the Phantom product.

[Codex hooks](https://learn.chatgpt.com/docs/hooks) can observe lifecycle events
or call connected MCP tools, with exact-definition trust review for non-managed
hooks. [Claude hooks](https://code.claude.com/docs/en/hooks) cover Code sessions
in CLI, IDE and Desktop. Proposed hooks should publish minimal authenticated
metadata into Phantom; hook output and imported app content remain untrusted
inputs, not permission to expand execution scope.

### Computer use for app-only workflows

[Claude's computer-use documentation](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
describes per-app permission, beta availability and macOS 15+ background windows.
The machine must remain awake and the app open. Background windows therefore
do not mean headless execution or survival through shutdown. This is Claude's
own facility, not proof that Phantom can invoke it externally.

Phantom already has a computer relay in source, with app grants, confirmation
cards, native checks and operator takeover. Its current relay needs a Verse
window. Qualify narrow app tasks through this existing path before adding more
control. UI layout, focus and accessibility changes make this a weaker transport
for durable session identity and completion than provider protocols.

## Existing Phantom foundations to reuse

| Existing source | Relevant behavior |
| --- | --- |
| [Session engine](../src/core/verse/session-engine.ts), [adapter contract](../src/core/verse/adapters/index.ts) | Durable lifecycle, normalized events, process ownership, cancellation and per-turn telemetry hooks |
| [Codex adapter](../src/core/verse/adapters/codex.ts), [Claude adapter](../src/core/verse/adapters/claude.ts) | Current CLI turn launch/resume and native session IDs; the Codex comments describe older pinned runtimes |
| [Session store](../src/core/verse/session-store.ts), [process registry](../src/core/verse/process-registry.ts) | Persistence, bounded history and recovery of owned subprocesses |
| [Handoff](../src/core/verse/session-handoff.ts) | Deterministic bounded continuation notes, secret scrubbing and explicit truncation; cross-provider continuation is a new session |
| [Codex probe helper](../src/core/resources/codex-account-probe-process.ts) | Bounded app-server handshake, message caps and account-identity checks; this is a resource probe, not a general session controller |
| [MCP bridge](../src/core/verse/verse-mcp-stdio.ts), [grants](../src/core/verse/verse-mcp-grants.ts) | Loopback routing and scoped, revocable per-turn tools |
| [Computer bridge](../src/core/verse/computer-bridge.ts), [computer MCP](../src/core/verse/verse-mcp-computer.ts), [native enforcement](../desktop/src-tauri/src/computer.rs) | Existing app-specific computer control and approval layers |
| [Codex observability](../src/core/observability/codex-source.ts), [reasoning ingestion](../src/core/reasoning/ingest-codex.ts) | Usage deduplication and explicit opt-in for personal interactive Desktop reasoning ingestion |

## Proposed capability architecture

This is an architectural proposal, not an implemented adapter expansion.

Phantom owns a task graph, shared evidence and review surface. Provider adapters
retain the native conversation and execution identity. Treat the execution
transport and the display surface as independent capabilities: native CLI,
SDK/app-server, Desktop review/handoff and computer relay can coexist.

Each observed session needs provider, runtime version, native session/thread/turn
IDs, canonical repository/worktree, owner, capability state, freshness and
source quality. Acquire an exclusive execution-owner lease before sending a
turn; observation alone must never silently adopt, fork or interrupt a session.

Use a durable event cursor and idempotent task-to-turn mapping, bounded stream
queues, terminal-state reconciliation and crash recovery. Account for shared
subscription quotas across Desktop and CLI without counting the same turn
twice. Unknown usage remains unknown. Cross-provider handoffs retain parent
lineage and source/evidence bindings while creating a separate native session.

The ambitious extension is a mission supervisor that routes independent tasks
to available engines, joins CI/PR/eval evidence, prepares reviews and resumes
work within explicit authority. Its optimization target is measured useful
delivery, latency and verified quality; app activity or critic ambition alone
does not establish successful delivery.

## Additive capability discovery in source

`phm resources launcher capabilities --provider codex|claude --command ABS_JSON
--cwd ABS_PRIVATE_DIR --json` is a help/version-only discovery surface in source
builds containing this command. It uses the existing trusted launcher input and
bounded runner, separates upstream advertised capabilities from implemented
Phantom transports, and inspects no sessions. `runtimeReadiness` is
`not-inspected`; `sessionsInspected` and `controlEnabled` remain false.
Vendor startup/cache side effects are not attested. Source availability does not
establish a published or installed release. See the
[resource-pool discovery contract](RESOURCE-POOLS.md#discover-advertised-native-session-surfaces).

The proposed session observation and ownership phases below remain unimplemented
by this addition. App-server protocol methods, daemon lifecycle, desktop transfer
and permission changes require their separate qualification.

## Parallel delivery tracks

Develop native background sessions with desktop handoff and direct desktop
operation together, keeping Phantom as the single user surface. The desktop
track extends the existing computer relay and preserves its Phantom-window
polling invariant. It needs app-specific grants, target binding, stale-state
refusal and verified readback before any controls can be enabled. Capability
discovery alone enables neither track.

## Proposed phases and acceptance criteria

1. **Inventory and observe.** Version-qualified capability reports, scoped
   session listings and provenance-aware status in Phantom. Pass bounded reads,
   permissions/privacy cases, malformed output and unavailable-source handling.
   Prove observation starts no turn and creates no execution-owner lease.
2. **Owned backend sessions.** Add Codex protocol/SDK and Claude streamed session
   adapters beside the current CLI adapters. Pass exact native-ID continuation,
   interrupted-turn recovery, duplicate-request reconciliation, token/cost
   deduplication, revocation and terminal-state checks. No double ownership.
3. **Desktop review and handoff.** Version-gated navigation, idle-session transfer
   and agent-native Phantom plugins. Pass user-visible target binding, active
   session refusal, same-provider identity preservation and cross-provider
   lineage. Prove prefilled drafts are distinct from sent turns.
4. **Unified background missions.** Supervise provider-native background work
   and owned Phantom processes with bounded scheduling and typed attention
   reasons. Pass concurrent-worktree isolation, quota exhaustion, provider
   outages, app closure, sleep/wake and restart reconciliation. Preserve required
   release gates and external-action authority.
5. **App-only automation.** Extend the existing computer relay for specific
   workflows after native routes are exhausted. Pass per-app grants, secure-field
   refusal, stale-frame/focus changes, untrusted-content boundaries, takeover,
   cancellation and verified post-action readback.

The first decision is which sessions Phantom may **own**, which it may only
**observe**, and which native desktop actions need a human handoff. Resolve
those boundaries and the installed-version gaps before implementing control.
