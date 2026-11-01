# Self-hosting Phantom

Phantom (`@ashlr/phantom`) is the open-source engineering agent workbench:
the `phm` CLI (`ashlr` is a compatible alias), a loopback console, a stdio
MCP gateway and the Universe experiment kernel — all on your machine against
your own provider accounts and models; there is no Phantom-hosted backend to
deploy. All state lives under `~/.ashlr/`.

## What runs locally

| Piece | Start it with | Where it listens |
| --- | --- | --- |
| CLI | `phm <command>` | your shell; `node bin/ashlr <command>` from a built checkout |
| Workbench console | `phm verse` | `http://127.0.0.1:7777/verse/` — binds 127.0.0.1 only, prints a read token and a mutation token |
| MCP gateway | `phm mcp` | stdio — launched once per agent client |
| Universe kernel | `phm universe demo --root <dir>` | a private experiment root you choose; execution needs macOS `sandbox-exec` |
| Resident runtime | `phm authority resident start` | macOS only, dormant by default, runs under a signed standing grant |

Provider accounts, API keys and local models stay yours — Phantom reads
account metadata, never billing; a passing `phm doctor` does not prove provider readiness.

## Requirements

- Node.js >=22.15.0 (`package.json` `engines`), npm and Git.
- CLI and console run on macOS, Linux and Windows; resident runtime and Universe experiment execution are macOS-only.

## Install

### From npm

```sh
npm install -g @ashlr/phantom
phm --version
```

### From source

[`install.sh`](https://github.com/ashlrai/phantom/blob/master/install.sh)
checks Node, installs dependencies, builds `dist/` and symlinks `phm` and
`ashlr` into `~/.local/bin`:

```sh
git clone https://github.com/ashlrai/phantom.git
cd phantom
./install.sh
phm --version      # re-open your shell if ~/.local/bin is not yet on PATH
```

Or build and run without touching PATH: `npm ci && npm run build`, then
`node bin/ashlr --version` (or `npm run dev -- --version` straight from
source via tsx). For a pinned, versioned source install see
[versioned self-swap](https://github.com/ashlrai/phantom/blob/master/docs/SELF-SWAP.md).

## First run

```sh
phm init        # writes ~/.ashlr/config.json, creates ~/.ashlr/genome, links ~/.local/bin/ashlr
phm doctor      # checks Node, git, config, providers and MCP registration; --fix auto-fixes
phm verse       # opens the workbench — keep the printed tokens private
```

`phm init --wire` also registers the MCP gateway in detected agents (below).
`phm onboard` walks the first safe activation (preflight → enroll one repo →
dry-run plan → inbox review); `phm preflight` is the read-only readiness
check. First-chat checklist: [Quickstart](QUICKSTART.md); console tour:
[first local session](VERSE.md#first-local-session).

## Data locations

`phm config path` prints the config path. Verified paths under `~/.ashlr/`:

| Path | Contents |
| --- | --- |
| `config.json` | roots, categories, model endpoints, telemetry |
| `settings.json` | MCP servers registered by `phm mcp ecosystem --write` |
| `enrollment.json` + `KILL` | enrolled repositories and the global stop marker |
| `genome/` | learned playbook knowledge |
| `inbox/`, `sandboxes/`, `audit/` | proposals, sandbox worktrees, audit trail |
| `account-connections/connections.json` | native account roster for seats |
| `authority/ledger.jsonl` | hash-chained authority ledger |
| `daemon.json`, `logs/`, `fleet/mirrors/` | daemon state, runtime output, fleet clones |

`~/.local/bin/phm` and `~/.local/bin/ashlr` are the PATH shims for a source
install. The full state map is in
[RELIABILITY](https://github.com/ashlrai/phantom/blob/master/docs/RELIABILITY.md#where-state-lives).

## Connect Claude Code and Codex over MCP

`phm mcp` is one stdio gateway: it serves Phantom's own tools plus every
server registered in `~/.ashlr/settings.json`, each tool prefixed with its
server name. Register detected companions, then probe them:

```sh
phm mcp ecosystem --write
phm mcp doctor
```

Then register the gateway as the `ashlr-hub` server in each agent. `phm wire`
backs the target config up first and is idempotent; `phm wire status` reports
detection and registration without writing:

```sh
phm wire claude     # merges "ashlr-hub" into ~/.claude.json
phm wire codex      # runs codex mcp add ashlr-hub -- ashlr mcp
phm wire all        # every detected client (claude, codex, cursor)
```

`phm mcp install claude` performs the same `~/.claude.json` write with an
absolute path to this install's `bin/ashlr`. By hand, add this entry under
`mcpServers` in the client's config:

```json
"ashlr-hub": { "command": "ashlr", "args": ["mcp"] }
```

Restart the agent so it reloads MCP servers. Companion install and the
combined tool surface: [one connection for every agent](COMPANIONS.md#one-connection-for-every-agent).

## Upgrade

- Source checkout: `phm update` (alias `phm upgrade`) fast-forwards with
  `git pull --ff-only`, runs `npm install` and `npm run build`, then checks
  the `~/.local/bin` symlink and a `help` smoke test. It aborts on a dirty
  tree; `phm update --check` is read-only. Equivalent by hand:
  `git pull --ff-only && npm ci && npm run build && ./install.sh`.
- npm install: `phm update` checks the registry, prints
  `npm install -g @ashlr/phantom@latest`, and `--yes` runs it.
- A running console picks up the new build on next start; re-open `phm verse`.

## Uninstall

1. Stop what is running: Ctrl-C the `phm verse` console. If an OS service was
   installed, `phm daemon service-status` shows it and `phm daemon stop` /
   `phm daemon uninstall` removes it. On macOS under a standing grant, run
   `phm authority resident stop` first. `phm onboard --rollback <repo>`
   reverses the guided activation.
2. Remove agent registrations: `codex mcp remove ashlr-hub`, and delete the
   `ashlr-hub` key under `mcpServers` in `~/.claude.json` and
   `~/.cursor/mcp.json`.
3. Remove the program: `npm uninstall -g @ashlr/phantom`, or for a source
   install `rm ~/.local/bin/phm ~/.local/bin/ashlr` and delete the checkout.
4. Remove all local state: `rm -rf ~/.ashlr` — config, enrollments, inbox,
   sandboxes, audit trail and genome go with it.

## See also

- [Agent operations guide](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-OPERATIONS.md#where-state-lives)
  for the cold-start checklist; `phm docs --agent --json` prints the command registry your binary supports.
- [Autonomy setup](AUTONOMY-SETUP.md) before granting the resident runtime standing authority; [Automatic work](AUTOMATIC-OUTCOMES.md) for readiness.
