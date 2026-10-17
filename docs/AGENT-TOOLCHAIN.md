# Agent toolchain: Phantom's own dev tools for agents working on Phantom

Phantom is built alongside Phantom Secrets, Locus, Lexicon, Stack, Cortex and
ashlr-md. An agent changing this repository (or a sibling) should use them the
way a user would. This page says what is wired, how, and where each tool stops.

## What is wired

[`.mcp.json`](../.mcp.json) at the repo root declares four stdio MCP servers,
each launched through `npx` at an exact version. The Secrets, Locus and Lexicon
pins match the reviewed releases in `src/core/companion-inventory.ts`;
`test/agent-toolchain-mcp.test.ts` fails if they drift.

| Server | Package | Use it to | Limit today |
| --- | --- | --- | --- |
| `phantom-secrets` | `phantom-secrets-mcp@0.7.9` | `phantom_check` before committing (no raw keys in `.env` files), `phantom_list_secrets` / `phantom_doctor` for value-blind vault state | Values never reach the agent; a run that needs a key uses `phantom exec`. The published 0.7.9 npm wrapper fails as root (fixed in ashlrai/phantom-secrets#191, unpublished), so a fresh root container needs a non-root user or the fixed wrapper. |
| `locus` | `@ashlrai/locus-mcp@0.5.0` | `locus_whoami` / `locus_safe_next` before acting for an account, `locus_request_pin` when the wrong identity is pinned | Agents cannot pin. Without a human `locus pin`, every tool answers "no active pin" and the agent must say so. |
| `lexicon` | `@ashlr/lexicon@0.5.4` (`lexicon-mcp`) | `normalize_transcript` on dictated tasks, `learn_correction` when a user corrects a word | Project terms apply only after `lexicon trust` on this repo's [`.lexicon.yaml`](../.lexicon.yaml), and only when the server's working directory (or `LEXICON_CWD`) is this repo. |
| `stack` | `ashlr-stack-mcp@0.1.1` with `@ashlr/stack@0.1.1` and `phantom-secrets@0.7.9` on its PATH | `stack_status`, `stack_doctor`, `stack_list` to see which services a project uses and whether their keys are in the vault | npm still has 0.1.1; `stack status --json` (ashlrai/ashlr-stack#30) is not published. `stack_apply` and `stack_add` provision real services; leave them to a human. |

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

- Autonomous Claude runs on macOS go through the native broker with only file
  tools (`src/core/sandbox/claude-native-broker.ts`); no MCP server is added.
- Non-autonomous sandboxed runs get a fleet MCP sidecar config with
  `--strict-mcp-config` (`src/core/run/sandboxed-engine.ts`). It holds the
  `ashlr` efficiency server when `ashlr-mcp` is on PATH, plus the
  `phantom-secrets`, `locus` and `lexicon` entries from the worktree's
  `.mcp.json`, each only when it matches the reviewed spec in
  `FLEET_COMPANION_MCP_SPECS` exactly (command `npx`, the same args, no env).
  Stack and any other entry are ignored. Codex gets only the `ashlr` sidecar.
  Set `foundry.fleetCompanionMcp: false` to leave the companions out.
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
