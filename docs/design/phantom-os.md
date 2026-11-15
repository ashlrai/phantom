# Phantom OS: one controller for the Mac fleet

Status: design, not implemented. Track PHANTOM-OS-1. This document grants no
runtime authority. Each phase below lands as its own PR, and the phases marked
for Security review need that review before merge.

Phantom OS is one controller on the Mac that lets every agent in the fleet use
the computer without friction: one list of capabilities, one desktop control
tool, one model gateway, credentials by reference, and a loop that files every
missing capability as work. It builds on what exists: the router and bandit
(`src/core/routing/`), the apps allowlist and desktop adapter
([apps control](../APPS-CONTROL.md)), Phantom Secrets
([companions](../COMPANIONS.md)), the four hard limits in the
[constitution](../../CONSTITUTION.md), and KILL.

## Surfaces and models are separate

A **surface** is the place a job runs: an app, a CLI, or a hosted session. A
**model** is the weights that answer. The registry stores them as separate
records, and the router and balancer choose a `(surface, model)` pair for each
job. They are never folded into one "agent" string.

| Surface | Kind | Models it can run |
| --- | --- | --- |
| Claude Desktop / Claude Code | app, CLI | Opus, Sonnet, Haiku, Fable 5.2 |
| Codex Desktop / Codex CLI | app, CLI | Codex models |
| Devin Desktop / Devin CLI | app, CLI, **hub** | its own models, plus hosted surfaces below |
| Cursor Desktop / cloud sessions | app, cloud | Cursor-routed models |
| Grok Bot Desktop | app | Grok models |
| local oMLX / Qwen | loopback server | Qwen and other local weights |

**Hosted-agent edges are first-class.** Devin is a hub that can host GLM Lite,
Cursor, Grok Build, Gemini, Copilot, Qwen, and Codex. The registry records each
as a `hosts` edge, `devin -> glm-lite`, with its own entitlement, so the router
can pick `(devin/glm-lite, glm-lite)` and the balancer counts it against the
right allowance. An edge carries no authority of its own: a hosted surface gets
at most the intersection of the hub's grants and its own.

**Fable 5.2 is a Claude model.** It sits beside Opus and Sonnet in the Claude
lane and counts against the Max weekly Fable allowance (see
`src/core/routing/fable-admission.ts`). It is not an agent and not an app. A
Fable session is a Claude Code surface pinned to the Fable model; the Weyv lead
is one such session.

## 1. Capability registry

One source of truth for MCP servers, skills, plugins, CLIs, connectors and
account references. Account references hold a name and scopes only, never a
value. A record looks like this (illustrative; PR 1 defines the schema):

```json
{
  "id": "mcp:phantom-secrets",
  "kind": "mcp",
  "surfaces": ["claude-code", "codex-cli", "devin-cli"],
  "credentialRefs": [{ "name": "github", "scopes": ["repo:read"] }],
  "danger": [],
  "egress": ["127.0.0.1"],
  "source": "repo:.mcp.json"
}
```

- `danger` is a closed set: `sends-outside`, `spends`, `deletes`. Empty means
  none. A loader rejects unknown values.
- `credentialRefs` is the only place a credential appears. The loader rejects
  any field that looks like a value (prefix, entropy and length checks shared
  with the secret gate).
- Per-target **adapters are generated** from the registry for Claude Code,
  Codex, Fable sessions (a Claude Code target with a model pin), Devin and each
  hosted surface, Cursor, Grok Build, Gemini, Copilot, and Qwen/oMLX and other
  local models. No config is copied by hand.
- Generators write only to the repo or a staging directory. They never write
  live into `~/.codex` or any other agent's home config. Installing a staged
  adapter is a separate, pinned step (see constraint e).
- `phm caps` lists, checks and diffs the registry against what each target
  would receive.

## 2. Desktop control layer

One tool, `desktop`, that every agent can call through the Phantom MCP gateway.
It dispatches only to sanctioned paths:

| Path | Use |
| --- | --- |
| Accessibility (AX) | read control labels and window titles, press controls |
| AppleScript / JXA | scriptable apps |
| Shortcuts | user-authored automations |
| App CLIs and URL schemes | `devin`, `codex`, `claude`, `open -a`, `phantom://` |
| computer-use | the existing `computer_*` tools via `src/core/verse/desktop-adapters.ts` |
| Managed browser | CDP/Playwright on 127.0.0.1 with a fresh per-run profile |

It must be able to drive Devin Desktop, the Phantom app, and the Claude and
Codex apps. It reuses the apps allowlist, the per-chat grant, tier ceilings,
the confirmation card, the denylist (Phantom itself, password managers,
keychain), takeover, and KILL. It never reads what is on screen into the
capability-gap filer (constraint f).

## 3. Model gateway

Any model through one CLI and API. Backends: subscription CLIs (Claude Code,
Codex, Devin and its hosted surfaces, Cursor, Grok Build where included), local
oMLX/Qwen on loopback, and APIs only where the plan includes them at no spend.
Routing extends `src/core/run/router.ts` and the bandit in
`src/core/routing/bandit.ts`: today an arm is `{provider, model, effort}`
(`src/core/routing/arms.ts`); Phantom OS adds `surface` so the arm is the
`(surface, model)` pair, and the reward adds loop velocity (time from dispatch
to verified result) beside outcome. Spend stays fenced by the existing
subscription-only boundary (`src/core/routing/subscription-only.ts`): a route
that would spend is not selectable.

## 4. Credentials by reference only

Agents name a credential; they never hold one. At use, the value is injected by
`phantom exec -- <cmd>` (which sees a `phm_` placeholder and a loopback proxy)
or by the keychain broker, and goes straight to the child process. It is not
returned to the agent, logged, or stored. Phantom OS does not read app
databases, token stores, or the TCC database, and does not touch `~/.codex`.

## 5. Self-improving auto-file

Every failed tool call or missing capability becomes a queue line. The filer
dedupes on a stable key (`capability id + failure class + surface`), rate-limits
per key and globally, does nothing while `RESTOCK_OFF` is set, and does nothing
while the repo is at the open-PR cap of 80. A filed line carries the
capability id, surface, model, error class and a redacted error code. It never
carries screen contents, window text, prompt text, or secrets.

## Phased PRs

| PR | Line | Scope | Review |
| --- | --- | --- | --- |
| 1 | RQ-PHOS-2-REGISTRY | registry schema, loader, adapter generator (staging only), tests, `phm caps` | normal |
| 2 | RQ-PHOS-3-CONTROL | `desktop` tool over the sanctioned paths | **Security before merge** |
| 3 | RQ-PHOS-4-GATEWAY | `(surface, model)` arms, loop-velocity reward, gateway CLI/API | normal |
| 4 | RQ-PHOS-5-CREDREF | credential references wired to `phantom exec` and the keychain broker | **Security before merge** |
| 5 | RQ-PHOS-6-AUTOFILE | deduped, rate-limited capability-gap filer | normal |
| 6 | RQ-PHOS-7-GLMLITE-SMOKE | smoke the Devin-hosted GLM Lite sub-lane | gated on Free |

## Security constraints and where they are enforced

These are requirements. Each row names the element that enforces it; a phase
that cannot meet its row does not merge.

| # | Constraint | Enforced by |
| --- | --- | --- |
| a | Desktop control uses sanctioned APIs only: AX, AppleScript/JXA, Shortcuts, app CLIs and URL schemes, CDP/Playwright on loopback with a per-run profile. No TCC DB or app DB reads; no cookie, token or keychain scraping; no TCC grants or prompts on another app's behalf. | **Runtime gate**: the `desktop` dispatcher has a closed `path` enum; anything else is refused before it runs. **Schema field**: registry `kind: desktop-path` entries are the only paths the dispatcher loads. The existing denylist and apps allowlist apply. A test asserts no code path opens `TCC.db`, browser cookie stores, or app support databases. **KILL** stops the dispatcher (row e). |
| b | Credentials by reference only. Injected at use via `phantom exec --` or the keychain broker; never returned to the agent, logged, or stored. The registry holds names and scopes only. | **Schema field**: `credentialRefs: {name, scopes}`; the loader rejects value-shaped strings anywhere in a record. **Runtime gate**: the only resolver is `phantom exec` / the keychain broker, whose output goes to the child process, not the tool result. Log writers pass through the secret redactor; a test seeds a canary value and asserts it never appears in output, logs or adapters. Hard limit (a). |
| c | Local models bind to 127.0.0.1 only. Keys are never forwarded to local URLs. Explicit egress allowlist. | **Schema field**: `egress` on every gateway backend; local backends must be exactly `127.0.0.1`. **Runtime gate**: the gateway refuses a local backend whose bind or URL is not loopback, strips auth headers on any loopback request, and refuses any host not in the backend's `egress` list. |
| d | Anything that sends outside (Mail, Messages, Slack posts), spends money, or deletes data is marked and callable only through the existing hard-limit gates. | **Schema field**: `danger: [sends-outside \| spends \| deletes]`; a capability with a matching effect but no tag fails registry tests. **Runtime gate**: a tagged capability is callable only through the hard-limit gates for sends (b/c), money and destruction (d); adapters for targets without those gates omit it. |
| e | Generated adapters are pinned artifacts; KILL stops the control layer. | **Pin-stage**: the generator emits adapters plus a sha256 manifest; installing them goes through SEC-PIN-STAGE-TOOL-2 (`pin_stage_lib` fe77a6a8), which refuses an adapter whose sha does not match. **KILL**: `~/.ashlr/KILL` or `~/.ashlr-runs/KILL` is checked before every `desktop` call and every gateway dispatch; when present both refuse and the control layer exits. |
| f | Capability-gap auto-filing never includes screen contents or secrets. | **Schema field**: the filed line is a closed record (capability id, surface, model, error class, redacted code); free text is not a field. **Runtime gate**: the filer builds lines from that record only, runs the secret redactor, and is off under `RESTOCK_OFF` or at the open-PR cap of 80. A test feeds AX text and a canary secret through a failing call and asserts neither reaches the queue. |

## Out of scope

- Implementation. This PR is the document only.
- Any write to `~/.codex`, any pinned bin, or the Mac release scripts.
- New paid API routes or Grok spend.
