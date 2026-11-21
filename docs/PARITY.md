# Agent class parity: tools, context and fleet visibility (RQ-TOOLPARITY-1)

Every agent class should reach the same kinds of information (tools, docs,
repo context, fleet state), adapted to its role. This page is a source audit,
not a health check: it records what repository code and the reviewed launcher
candidate wire for each class, where classes differ, and which differences are
deliberate. It extends the narrower lane table in
[AGENT-TOOLCHAIN.md](AGENT-TOOLCHAIN.md#lane-tool-parity-audit-rq-delegate-scope-1).
A declared server does not prove the process started or the account is
authorized; check the live session's discovered tool list before assigning a
brief that needs a specific tool.

Legend: **yes** = wired in source; **no** = absent; **?** = not verifiable from
this repository (config lives on the host, or is Security-pinned and
hash-checked); **by design** = absent on purpose, see
[Intentional limitations](#intentional-limitations). Evidence paths are
relative to the repository root.

## Matrix

| Class | MCP servers | Bus read / write | Web | Repo context | Fleet telemetry | Docs |
| --- | --- | --- | --- | --- | --- | --- |
| **Mac CLI lanes** | | | | | | |
| `codex-cmp`, `codex-personal` | `context7`, guarded `fetch` (`-c` flags, `LANE-MCP rev1`); personal adds a deny-by-default apps profile. No Phantom MCP, no repo companions | Identity: no (launcher sets no `PHM_AGENT_ID`). Read/write: only through `phm` CLI if the job runs it | yes (`web_search=live`) plus guarded `fetch` | Worktree (`-C`), `AGENTS.md` | Job prompt carries a fleet CONTEXT block; `phm context --for-agent` by CLI | `context7` |
| `codex-local` | Same `context7` and `fetch` flags | Same as above | **by design** (loopback-only inference; no `web_search` flag) | Worktree | Prompt block | `context7` |
| `claude` | Pinned lane `mcp.json` via `--strict-mcp-config` (`context7`, `fetch`); excludes the six repo companions | Same as above | Native Claude web tools **?**; guarded `fetch` | Worktree, `CLAUDE.md` | Prompt block | `context7` |
| `claude-api` | Same pinned file | Same | Same | Worktree | Prompt block | `context7` |
| `zai` | Same pinned file, Claude Code on GLM | Same; bus provider `glm` now accepted | Same as `claude` | Worktree | Prompt block | `context7` |
| `gemini` | Pinned system settings; launcher comments disagree on whether MCP is on | **?** | **?** | Worktree | Prompt block | **?** |
| `agy`, `grok`, `cursor` | Pinned `mcp_config.json`, `config.toml`, `mcp.json` respectively, same shared set intended | **?** (`grok` and `cursor` have bus CLI adapters, nothing sets their env) | **?** | Worktree | Prompt block | **?** |
| `devin`, `devin-flash` | None injected by the launcher; native Devin tools unknown | **?** (bus adapter exists, nothing sets its env) | **?** | Worktree, `--prompt-file` | Prompt block | **?** |
| **Sandboxed fleet engine** | | | | | | |
| Claude, non-autonomous | `ashlr` plus reviewed `phantom-secrets`, `locus`, `lexicon` specs; `stack` excluded | no | Per run | Run worktree | `fleet_status` etc. only via the standalone `phm mcp fleet` entry, not auto-added | `context7` not in sidecar |
| Codex, non-autonomous | `ashlr-efficiency` only | no | no | Run worktree | no | no |
| Autonomous Claude (native broker) | Only `ashlr-fleet-broker` | **by design** (no free bus access) | **by design** | Run worktree | Broker tools | **by design** |
| **Node-pool workers** | | | | | | |
| `mbp` / `muse` / `air`, pack `codex-file` and runner packs `shell-check`, `omlx-chat` | **by design**: none | **by design**: none; result goes through fenced `complete` only | **by design** | **by design**: no repo, no cwd (`/`) | **by design**: runner takes no prompt; the only input is a job id and a closed pack name | **by design** |
| **iMessage teammates** | | | | | | |
| `dot` (Codex-backed), `instinct` (independent, own GitHub) | Outside this repo; Phantom talks to them over iMessage only | Via `phm` iMessage task ledger (`src/core/comms/imessage-teammate-tasks.ts`): bounded kinds `research`, `triage`, `report`, `rebase`, 24 attempts/day each | Their own | Their own | Observed through `fleet_imessage_tasks` / `fleet_imessage_acks` | Their own |
| **Desktop sessions** | | | | | | |
| Claude, Codex, Devin, Cursor, Grok Bot apps | Per app; none configured by this repo | Operator reads open; writes only via the exact-bundle-id operator allowlist (`src/core/desktop/operator-policy.ts`) | Per app | Per app | `phm_context_brief`, `phantom_observe` if the app has the Phantom MCP **?** | Per app |
| **Interactive sessions in this repo** | | | | | | |
| Claude Code / cloud Claude | Six `.mcp.json` companions, after approval | Read/write through the Phantom MCP when wired (`phm wire claude`) | yes | yes | Phantom MCP `phantom_*`, `phm_*` tools when wired | `context7` |

### Capability reference

| Capability | Where it comes from |
| --- | --- |
| Phantom MCP gateway | `phm mcp` (aggregation gateway). `phm wire [claude\|codex\|cursor]` registers it as `ashlr-hub`; **gemini is status-only** (`phm wire status gemini`). |
| Read-only fleet MCP | `phm mcp fleet`, entry `phantom-fleet` ([FLEET-MCP-ONRAMP.md](FLEET-MCP-ONRAMP.md)); `fleet_status`, `fleet_loop`, `fleet_bus_hops`, `fleet_orchestration_read`, iMessage observers. No mutation tools. |
| Bus read | `phantom_agent_bus_read`, `phantom_agent_bus_status`, `phm_team_view` ([MCP-TOOLS.md](MCP-TOOLS.md)). |
| Bus write | `phantom_agent_bus_post`, `phm_team_publish`; envelopes are untrusted data and authorize nothing. |
| Fleet brief | `phm context --for-agent <lane> --json` / `phm_context_brief`: under 4 KB, read-only. |
| Bus identity | `PHM_AGENT_ID` plus `PHM_AGENT_CLI` or a CLI marker (`src/core/agents/bus-cli-adapters.ts`). Adapters exist for `claude`, `codex`, `devin`, `cursor`, `grok`; none for `gemini` or `agy`. |
| Docs | `context7` (remote, keyless) in the lane MCP set; repo docs in the worktree. |

## Gaps

| # | Gap | Status |
| --- | --- | --- |
| 1 | `zai` (Claude Code on GLM) and `codex-local` could not attach to the bus with their true provider, although `glm` and `local` already exist in the v2 schema | **Fixed here**: the `claude` adapter now accepts provider `glm` and the `codex` adapter `local`. Identity metadata only. |
| 2 | The Mac launcher sets no `PHM_AGENT_ID` / `PHM_AGENT_CLI`, so no lane has a bus identity unless a job's own command attaches one | Open. Needs a Security-pinned launcher change; repo copies in `contrib/mac/` are not installed over the live launcher by any operator lane. |
| 3 | No lane gets the Phantom MCP (`phm mcp`) or `phantom-fleet`; every lane gets only `context7` and `fetch`. Lanes read fleet state through the prompt's CONTEXT block or the `phm` CLI | Open. Adding a server to the pinned `~/.lane-mcp/mcp.json` changes a hash-checked file and needs a Security pin. A read-only `phantom-fleet` entry is the candidate (no tools that mutate, no secrets, no env). |
| 4 | `gemini` has no bus CLI adapter, and its MCP status is contradictory in launcher comments | Open. Adding a CLI to `BUS_CLIS` widens the v2 identity contract (`test/agent-bus-unified.test.ts` asserts `gemini` is absent); do it deliberately with a `CONTRACT.md` update. |
| 5 | `phm wire` cannot write Gemini's `~/.gemini/settings.json` | Left as is. The Mac Gemini lane reads pinned system settings, not user settings, so a user-file write would not reach it. |
| 6 | Web search differs by lane: only `codex-cmp` and `codex-personal` pass `web_search=live` | Partly by design (`codex-local`). The others are unverified; check the lane before assigning research. |
| 7 | Desktop apps cannot reach the bus unless the Phantom MCP is wired into that app's own config | Open, per-app. `phm wire` covers Claude, Codex and Cursor configs; Devin and Grok Bot apps are not wire targets. |
| 8 | Node workers receive no fleet snapshot or job spec | **By design**, see below. Not repaired. |

## Intentional limitations

- **Node-pool workers: no MCP, no bus, no network, no prompt.** The runner
  (`src/core/drive/nodes/runner.ts`) is a closed protocol. A queue entry can
  select a pack (`shell-check`, `omlx-chat`), never a command, prompt, URL or
  environment. `shell-check` runs fixed code under Node's permission sandbox;
  `omlx-chat` posts a fixed prompt to a numeric loopback endpoint. A "bounded
  context pack" injected into either would be queue-supplied prompt text, which
  the protocol exists to forbid, so none was added. If workers ever run a real
  agent, give them a read-only snapshot written by the leader into the job's
  own result directory, never a write MCP.
- **Workers and autonomous runs never get write MCP.** Observation tools only;
  job queueing, claims, needs-resolution and spend stay with the leader and
  the owner.
- **`codex-local` has no web.** Its inference is loopback-only; adding live web
  search would break that boundary.
- **Repo companions (`phantom-secrets`, `locus`, `lexicon`, `stack`) stay out
  of strict lane configs.** `stack` provisions real services and is
  human-only; the others need a verified account or a per-machine setup.
- **iMessage teammates get bounded task kinds and a daily attempt budget,** and
  their replies are untrusted data. They hold their own GitHub access; this
  repo grants none.
- **Desktop writes use an exact bundle-id allowlist.** A name match or a
  missing bundle id never unlocks a write.
- **Bus identity is routing metadata.** Registering a handle grants no tool,
  spend, send or execution authority.
- **No secrets in any config.** Everything above goes through existing config
  surfaces (`phm wire`, pinned lane files, `CODEX_HOME` `config.toml`), value-blind.

## Check it

```sh
phm mcp list --json
phm wire status --json
phm mcp doctor --json
phm context --for-agent codex-personal --json
npx vitest run test/agent-bus-unified.test.ts test/parity-doc.test.ts
```

`test/parity-doc.test.ts` fails if a fleet lane drops out of the matrix or a
cited source file moves.
