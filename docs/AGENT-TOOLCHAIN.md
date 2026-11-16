# Agent toolchain: Phantom's own dev tools for agents working on Phantom

Phantom is built alongside Phantom Secrets, Locus, Lexicon, Stack, Cortex and
ashlr-md. An agent changing this repository (or a sibling) should use them the
way a user would. This page says what is wired, how, and where each tool stops.

## What is wired

[`.mcp.json`](../.mcp.json) at the repo root declares five stdio MCP servers,
each launched through `npx` at an exact version. The Secrets, Locus and Lexicon
pins match the reviewed companion releases in `src/core/companion-inventory.ts`.
The Stack CLI and MCP pins match the separately qualified
[0.3.6 release](https://github.com/ashlrai/ashlr-stack/releases/tag/v0.3.6).
`test/agent-toolchain-mcp.test.ts` fails if they drift.

| Server | Package | Use it to | Limit today |
| --- | --- | --- | --- |
| `phantom-secrets` | `phantom-secrets-mcp@0.7.9` | `phantom_check` before committing (no raw keys in `.env` files), `phantom_list_secrets` / `phantom_doctor` for value-blind vault state | Values never reach the agent; a run that needs a key uses `phantom exec`. The published 0.7.9 npm wrapper fails as root (fixed on Secrets main in ashlrai/phantom-secrets#206, unpublished), so a fresh root container needs a non-root user or the fixed wrapper. |
| `locus` | `@ashlrai/locus-mcp@0.7.0` | `locus_whoami` / `locus_safe_next` before acting for an account, `locus_request_pin` when the wrong identity is pinned | Control tools remain available without a pin; provider operations need a verified sealed identity and its scopes. Agents cannot pin. |
| `lexicon` | `@ashlr/lexicon@0.5.9` (`lexicon-mcp`) | `normalize_transcript` on dictated tasks, `learn_correction` when a user corrects a word | Project terms apply after `lexicon trust` on this repo's [`.lexicon.yaml`](../.lexicon.yaml), with the server's working directory (or `LEXICON_CWD`) selecting this repo. A project correction writes to the tracked `.lexicon.yaml`; keep that change distinct from unrelated source work. |
| `stack` | `ashlr-stack-mcp@0.3.6` with `@ashlr/stack@0.3.6` and `phantom-secrets@0.7.9` on its PATH | `stack_status`, `stack_doctor`, `stack_list` to see which services a project uses and whether their keys are in the vault | Published 0.3.6 includes `stack status --json` and the 19-tool MCP interface. Provider credentials and project setup still apply. `stack_apply` and `stack_add` provision real services; leave them to a human. |
| `ashlr` | `ashlr-plugin@1.36.4` (`ashlr-mcp`), the Ashlr.AI Plugin | `ashlr__grep`, `ashlr__read`, `ashlr__tree` and `ashlr__bash` for compact search, reads and command output; `ashlr__savings` for token accounting | Needs Bun and ripgrep on PATH. The router runs from its package directory, so `.mcp.json` names the project in `ASHLR_ALLOW_PROJECT_PATHS` (`${PWD}`, the directory Claude Code started in). Pass absolute paths and an explicit `cwd`; a relative path or a missing `cwd` resolves inside the plugin's own install. |

Not wired, and why:

- **Cortex** runs as a hosted app. Its local stdio MCP entry (ashlr-cortex#47)
  needs `CORTEX_TOKEN` and `DATABASE_URL`, which a repo file must not carry.
  Add it per machine with `claude mcp add` against a dev database.
- **ashlr-md** exposes MCP only from inside the desktop app. A headless agent
  writes Markdown; a human opens it with `mdopen`.

## Approve the servers once

Claude Code asks before starting servers from a repo's `.mcp.json`, and a
repo cannot approve its own servers. Interactive sessions show the prompt once.
Headless runs pass the file explicitly:

```sh
claude -p "<task>" --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools "mcp__lexicon__normalize_transcript" "mcp__locus__locus_whoami" \
                 "mcp__phantom-secrets__phantom_check" "mcp__stack__stack_status" ...
```

The first launch downloads each package and, for Secrets and Locus, a native
binary from the GitHub release. Later launches use the npm and binary caches.

## What Phantom's own runs get

- Autonomous Claude runs on macOS go through the restricted native broker
  (`src/core/sandbox/claude-native-broker.ts`), with built-in tools disabled
  and only the `ashlr-fleet-broker` MCP tools allowed. No companion sidecar is added.
- Non-autonomous sandboxed runs get a fleet MCP sidecar config with
  `--strict-mcp-config` (`src/core/run/sandboxed-engine.ts`). It holds the
  `ashlr` efficiency server when `ashlr-mcp` is on PATH (with
  `ASHLR_ALLOW_PROJECT_PATHS` set to the run's worktree), plus the
  `phantom-secrets`, `locus` and `lexicon` entries from the worktree's
  `.mcp.json`, each only when it matches the reviewed spec in
  `FLEET_COMPANION_MCP_SPECS` exactly (command `npx`, the same args, no env).
  Stack and any other entry are ignored. Codex gets only the `ashlr` sidecar,
  with the same project path. Set `foundry.fleetCompanionMcp: false` to leave the companions out.
- `phm cloud launch` starts a Claude Code cloud session on the repository, which
  sees `.mcp.json` like any other session. Its task prompt names each declared
  companion and when to call it, and asks for the tools it called in the
  report's optional `toolsUsed` list. `phm cloud list` prints that list as
  `Companion tools: ...` (`none called` for an empty list).

## Check it

```sh
claude mcp list                               # from the repo root; shows each server's state
npx vitest run test/agent-toolchain-mcp.test.ts
node scripts/companion-workflow-smoke.mjs     # cross-tool smoke (ashlrai/phantom#751)
```

## Lane tool parity audit (RQ-DELEGATE-SCOPE-1)

This is a read-only source audit of the repository launcher candidate and
engine adapters, not proof of installed lane health. A server declaration
does not prove that the process started or that an account is authorized.
No credential, auth file, TCC grant or lane configuration was changed.

| Execution path / lanes | MCP servers supplied by this path | Gaps for task assignment |
| --- | --- | --- |
| Mac `codex-cmp`, `codex-personal` | `context7`, guarded `fetch` through per-invocation `-c` flags; pinned lane MCP files checked | No companion injection from the repository `.mcp.json`. Personal also uses a pinned, deny-by-default apps profile; an app being installed does not grant its tools. |
| Mac `codex-local` | Same `context7` and guarded `fetch` flags | No companion injection; model inference remains loopback-only and prompt scope stays fast. Remote documentation MCP endpoints are distinct from model inference. |
| Mac `claude`, `claude-api`, `zai` | Pinned lane `mcp.json` via `--strict-mcp-config`, intended shared `context7` and guarded `fetch` set | Strict configuration excludes the repository's five companions. Do not assume the broader interactive Claude tool set. |
| Mac `gemini`, `agy`, `grok`, `cursor` | Lane-specific, hash-checked system settings, `mcp_config.json`, `config.toml`, or `mcp.json`; launcher comments identify the shared lane set | Actual contents and tool health are unverified here. Gemini comments conflict about MCP being disabled versus supplied in pinned settings; resolve with host-owned evidence before assigning a required tool. |
| Mac `devin` | No explicit MCP config or server injection in the launcher command | Native provider tool inventory is unknown; repository companion availability cannot be inferred. |
| Sandboxed engine, non-autonomous Claude | `ashlr` when installed; reviewed `phantom-secrets`, `locus`, `lexicon` from matching repo specs | `stack` excluded. Companions can be disabled by `foundry.fleetCompanionMcp`; sidecar also depends on `foundry.fleetMcp`. |
| Sandboxed engine, non-autonomous Codex | Only `ashlr-efficiency` when its command is available | Companion specs in the Claude sidecar do not become Codex tools. Secrets, identity, transcript and service tasks need verified alternative access. |
| Autonomous / standing native engine paths | No unconfined fleet sidecar; Claude native broker supplies only restricted `ashlr-fleet-broker` MCP tools | `claudeBrokerCommand` disables built-in tools and permits only the broker server. Repository companions are not added. |
| Interactive / cloud Claude in this repo | Five declared companions, subject to approval, installation and account scopes | Registration and `.mcp.json` presence alone do not establish readiness. Cloud reports must list tools actually called. |

Evidence: [Mac launcher candidate](../contrib/mac/host-integration/launch.candidate.sh),
[`prepareFleetMcpConfig` and `fleetEfficiencyMcpArgs`](../src/core/run/sandboxed-engine.ts),
[`claudeBrokerCommand`](../src/core/sandbox/claude-native-broker.ts), and
[the repository declarations](../.mcp.json). This audit does not inspect private
lane config contents. Other launchers, including Devin Flash, remain unverified.

Before assigning a brief, name the tools its acceptance needs and compare them
with the actual session's discovered tool list. Flag a gap in the handoff with
the required server/tool, execution path, evidence and a feasible alternative.
For example, a Codex identity task needing `locus_whoami` cannot rely on Claude's
companion sidecar; use an already authorized scoped CLI if it supplies the same
operation, or propose a capable lane. A Stack provisioning task has both an MCP
gap in these confined paths and a separate spending/authorization boundary.
Missing access never authorizes copying credentials or broadening an allowlist.

Copy-paste read-only diagnostics:

```sh
phm mcp list --json
phm wire status --json
phm mcp doctor --json
```

`list` inventories the current host and `wire status` checks registration;
neither proves per-lane tool health. `doctor` may start trusted executable
probes and returns nonzero for unhealthy required servers. This job's host
reported an unwired Claude gateway and unreadable Codex/Cursor/Gemini client
configs. Those observations do not prove that the separate lane configs lack
servers. Required lane tools remain unknown until checked in that lane.
