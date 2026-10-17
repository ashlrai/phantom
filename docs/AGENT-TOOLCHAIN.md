# Agent toolchain: Phantom's own dev tools for agents working on Phantom

Phantom is built alongside Phantom Secrets, Locus, Lexicon, Stack, Cortex and
ashlr-md. An agent changing this repository (or a sibling) should use them the
way a user would. This page says what is wired, how, and where each tool stops.

## What is wired

[`.mcp.json`](../.mcp.json) at the repo root declares five stdio MCP servers,
each launched through `npx` at an exact version. The Secrets, Locus and Lexicon
pins match the reviewed releases in `src/core/companion-inventory.ts`;
`test/agent-toolchain-mcp.test.ts` fails if they drift.

| Server | Package | Use it to | Limit today |
| --- | --- | --- | --- |
| `phantom-secrets` | `phantom-secrets-mcp@0.7.9` | `phantom_check` before committing (no raw keys in `.env` files), `phantom_list_secrets` / `phantom_doctor` for value-blind vault state | Values never reach the agent; a run that needs a key uses `phantom exec`. The published 0.7.9 npm wrapper fails as root (fixed on Secrets main in ashlrai/phantom-secrets#206, unpublished), so a fresh root container needs a non-root user or the fixed wrapper. |
| `locus` | `@ashlrai/locus-mcp@0.5.0` | `locus_whoami` / `locus_safe_next` before acting for an account, `locus_request_pin` when the wrong identity is pinned | Agents cannot pin. Without a human `locus pin`, every tool answers "no active pin" and the agent must say so. |
| `lexicon` | `@ashlr/lexicon@0.5.4` (`lexicon-mcp`) | `normalize_transcript` on dictated tasks, `learn_correction` when a user corrects a word | Project terms apply only after `lexicon trust` on this repo's [`.lexicon.yaml`](../.lexicon.yaml), and only when the server's working directory (or `LEXICON_CWD`) is this repo. |
| `stack` | `ashlr-stack-mcp@0.1.1` with `@ashlr/stack@0.1.1` and `phantom-secrets@0.7.9` on its PATH | `stack_status`, `stack_doctor`, `stack_list` to see which services a project uses and whether their keys are in the vault | npm still has 0.1.1; `stack status --json` (ashlrai/ashlr-stack#30) is not published. `stack_apply` and `stack_add` provision real services; leave them to a human. |
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

Phantom's sandboxed runs do not start servers from this file directly:

- Autonomous Claude runs on macOS go through the native broker with only file
  tools (`src/core/sandbox/claude-native-broker.ts`); no MCP server is added.
- Non-autonomous sandboxed runs write a fleet sidecar config with
  `--strict-mcp-config` (`prepareFleetMcpConfig` in
  `src/core/run/sandboxed-engine.ts`). It adds the Ashlr.AI Plugin when
  `ashlr-mcp` is installed, plus the Secrets, Locus and Lexicon entries of this
  file when they match the reviewed specs exactly. Set
  `foundry.fleetCompanionMcp=false` to leave the companions out.
- `phm cloud launch` starts a Claude Code cloud session on the repository, which
  sees `.mcp.json` like any other session.

## Check it

```sh
claude mcp list                               # from the repo root; shows each server's state
npx vitest run test/agent-toolchain-mcp.test.ts
node scripts/companion-workflow-smoke.mjs     # cross-tool smoke (ashlrai/phantom#751)
```
