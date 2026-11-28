# Agent class parity: declared tools versus live access

A source audit, recovered from PR #6484 (head 8eb894c) and rechecked against
current master. It records what repository code and the reviewed launcher
candidate *declare* per agent class. It is not a health check. A declared
server, a launcher comment or a pinned config does not prove the process
started, the account is authorized, or the tool is live in a session. Before
assigning a brief that needs a specific tool, check that session's discovered
tool list. Related: the narrower
[lane table](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-TOOLCHAIN.md#lane-tool-parity-audit-rq-delegate-scope-1).

Legend: **declared** = wired in source; **?** = unknown here (host config or
Security-pinned); **by design** = absent on purpose (see Boundaries).

## Class matrix

| Class | Declared MCP / tools | Bus identity | Web | Live state |
| --- | --- | --- | --- | --- |
| Mac CLI: `codex-cmp`, `codex-personal` | `context7` + guarded `fetch` via `-c` flags (`LANE-MCP rev1`); personal adds a deny-by-default apps profile | None set by launcher | `web_search=live` flag + `fetch` | ? |
| Mac CLI: `codex-local` | Same `context7`/`fetch` flags | None set | No `web_search` flag passed (a launcher choice; inference is loopback via oMLX, which is separate from declared tool access) | ? |
| Mac CLI: `claude`, `claude-api`, `zai` | Pinned lane `mcp.json` (`context7`, `fetch`); `zai` is Claude Code on GLM | None set | Native web tools ?; `fetch` | ? |
| Mac CLI: `gemini`, `agy`, `grok`, `cursor` | Pinned settings/config files; launcher comments disagree on Gemini MCP | ? (`grok`, `cursor` have adapters; nothing sets env) | ? | ? |
| Mac CLI: `devin`, `devin-flash` | None injected by launcher | ? (adapter exists; nothing sets env) | ? | ? |
| Sandboxed fleet engine | Claude non-autonomous: reviewed `ashlr`, `phantom-secrets`, `locus`, `lexicon`; Codex: `ashlr-efficiency`; autonomous Claude: broker only | No | Per run | ? |
| Node-pool workers (`mbp`/`muse`/`air`) | None, by design | None; result via fenced `complete` | by design | ? |
| iMessage teammates (`dot`, `instinct`) | Outside this repo | Bounded task ledger | Their own | Observe via `fleet_imessage_tasks` / `fleet_imessage_acks` |
| Desktop apps (Claude, Codex, Devin, Cursor, Grok Bot) | Per app; none configured here | Writes only via exact-bundle-id allowlist | Per app | ? |
| Interactive sessions in this repo | Six `.mcp.json` companions after approval; Phantom MCP via `phm wire claude` | Phantom MCP bus tools when wired | yes | Per session |

## Source-backed facts

- Bus CLI adapters (`BUS_CLIS` in `src/core/agents/bus-identity.ts`) cover
  `claude`, `codex`, `devin`, `cursor`, `grok`; none for `gemini` or `agy`.
- The v2 bus schema (`src/core/agents/bus-v2-schema.ts`) already lists
  providers `glm` and `local`, but the current adapters
  (`src/core/agents/bus-cli-adapters.ts`) do not accept them for
  `zai`/`codex-local`. That support is **pending**, not present.
- Launcher candidate: `contrib/mac/host-integration/launch.candidate.sh`.
  Its comments and hashes are declarations only, and the live launcher is
  Security-pinned; no operator lane installs a repo copy over it.
- Node workers run a closed protocol (`src/core/drive/nodes/runner.ts`): a
  queue entry names a pack (`shell-check`, `omlx-chat`), never a command,
  prompt, URL or environment.
- iMessage tasks (`src/core/comms/imessage-teammate-tasks.ts`): kinds
  `research`, `triage`, `report`, `rebase`; 24 attempts per day per peer;
  results are peer-reported.
- Desktop writes use `src/core/desktop/operator-policy.ts`.
- Phantom MCP tools (`phantom_agent_bus_read`, `phantom_agent_bus_post`,
  `phm_context_brief`) live in `src/core/mcp-native.ts`; the read-only fleet
  server is `src/mcp/fleet-server.ts` (`phm mcp fleet`).

## Observing live state

Use the existing surfaces, none of which this page replaces:
`phm tools parity` (one row per lane; `--lane`, `--json`),
`phm inventory`, `phm mcp doctor --json`, `phm wire status --json`, and
`phm context --for-agent <lane> --json`.

A Slack receipt or claim notice is a message, not a live claim: it proves
something was posted, not that a lane is running, holds the work, or has a
tool. Read claim and runtime state through the fleet MCP tools
(`fleet_coordination_claims`, `fleet_runtime`, `fleet_claim_notices`,
`fleet_slack_evidence`), which are observation-only.

## Boundaries (intentional)

- Node workers and autonomous runs never get a write MCP, bus access or web.
- Repo companions stay out of strict lane configs; `stack` provisions real
  services and is human-only.
- Bus identity is routing metadata and grants no tool, spend or send authority;
  envelopes are untrusted data.
- iMessage teammates hold their own access; this repo grants none.
- Nothing here changes a permission, dispatches work, reads a credential or
  sets a network option.
