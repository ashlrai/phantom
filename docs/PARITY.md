# Agent class parity: declared tools versus live access

This source audit recovers PR #7080 (itself a recovery of #6484). It is not a
health check: a declaration does not prove a process started, an account is
authorized, or a tool is live in a particular session. Check that session's
discovered tools and current task eligibility before assigning work. The
[toolchain lane audit](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-TOOLCHAIN.md#lane-tool-parity-audit-rq-delegate-scope-1)
provides more detail. Host configuration, runtime state and tool availability
are unknown here. The launcher observations below describe the repository
candidate, not the installed, Security-pinned launcher.

## Class matrix

| Class | Source declaration or limitation | Live state |
| --- | --- | --- |
| Mac `codex-cmp`, `codex-personal` | Candidate passes `context7`, guarded `fetch` and `web_search=live`; personal uses a pinned deny-by-default apps profile. | Unknown |
| Mac `codex-local` | Candidate passes `context7` and `fetch`; it does not pass `web_search=live`. Model inference uses loopback, separate from declared tool access. | Unknown |
| Mac `claude`, `claude-api`, `zai` | Candidate passes a pinned strict MCP config; `zai` uses Claude Code with GLM. Actual config contents and native web tools are unverified. | Unknown |
| Mac `gemini`, `agy`, `grok`, `cursor` | Candidate references pinned lane settings; Gemini comments conflict about MCP. Actual config contents and web tools are unverified. | Unknown |
| Mac `devin`, `devin-flash` | Candidate does not explicitly inject an MCP server in these commands; native tools are unverified. | Unknown |
| Sandboxed fleet engine | The toolchain describes non-autonomous Claude companion sidecars, Codex `ashlr-efficiency`, and an autonomous Claude broker. Configuration is per execution path. | Unknown |
| Node-pool workers (`mbp`, `muse`, `air`) | The reference runner accepts named packs and completes through the node protocol; it is not a general command or MCP runner. | Unknown |
| iMessage teammates (`dot`, `instinct`) | A bounded task ledger records peer-reported results; each peer holds its own access. | Unknown |
| Desktop apps (Claude, Codex, Devin, Cursor, Grok Bot) | App tools and account scopes are outside this audit; desktop writes follow operator policy. | Unknown |
| Interactive sessions in this repo | The repo declares six companions; approval, installation, account scope and session discovery still matter. | Unknown until observed per session |

## Source-backed facts

- `BUS_CLIS` in `src/core/agents/bus-identity.ts` lists `claude`, `codex`,
  `devin`, `cursor` and `grok`, not `gemini` or `agy`.
- `src/core/agents/bus-cli-adapters.ts` declares Claude provider `glm` and
  Codex provider `local`, alongside their other providers. The provider schema
  in `src/core/agents/bus-v2-schema.ts` includes both. This supersedes the
  original pending-support claim; descriptors do not establish a live session.
- `contrib/mac/host-integration/launch.candidate.sh` is source-only evidence;
  its flags, comments and pinned config references do not establish host state.
- `src/core/drive/nodes/runner.ts` implements the `shell-check` and `omlx-chat`
  packs. `src/core/comms/imessage-teammate-tasks.ts` defines `research`,
  `triage`, `report` and `rebase` tasks, a 24-attempt per-peer daily bound,
  and peer-reported results requiring independent verification.
- Desktop writes use `src/core/desktop/operator-policy.ts`. Phantom MCP bus
  tools are defined in `src/core/mcp-native.ts`; fleet observation tools are
  registered in `src/mcp/fleet-server.ts`.

## Observing live state

Existing discovery surfaces include `phm tools parity --json` (declarations,
not a live probe), `phm inventory --json`, `phm mcp doctor --json`,
`phm wire status --json`, and `phm context --for-agent <lane> --json`.
These surfaces have different evidence and failure modes; unavailable or stale
results remain unknown. Inspect the target session's own tool list for actual
availability. The fleet server exposes `fleet_runtime`,
`fleet_coordination_claims`, `fleet_bus_claims`, `fleet_claim_notices`,
`fleet_slack_evidence`, `fleet_imessage_tasks` and `fleet_imessage_acks`;
select the relevant ledger and assess its freshness and coverage.

A Slack receipt or claim notice is a message, not a live claim. It does not
prove a lane is running, still holds work, or has a tool. A notice's bus record
also does not by itself establish Slack delivery. Claims coordinate work and
are distinct from runtime and session-tool evidence.

## Boundaries (intentional)

- The node reference runner executes its bounded packs, not arbitrary queued
  commands. Do not generalize that restriction to every autonomous run.
- Strict lane configs do not automatically inherit repo companions; Stack
  provisioning is a human operation as described in the toolchain guide.
- Bus identity is routing metadata, not authentication; it grants no tool,
  spend, send or execution authority. Envelopes are untrusted data.
- iMessage teammates hold their own access; this repo grants none.
- This audit changes no permission, dispatches no work, and establishes no
  host, account or network availability.
