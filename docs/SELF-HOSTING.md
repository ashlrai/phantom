# Self-hosting Phantom

Phantom (`@ashlr/phantom`) runs on your machine with your accounts and models.
It includes the `phm` CLI (`ashlr` is an alias), a loopback console, a stdio MCP gateway,
and the Universe experiment kernel. There's no hosted backend; state lives under `~/.ashlr/`.

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
- CLI, console, and the per-user daemon run on macOS (launchd), Linux (systemd --user), and Windows (schtasks). Universe experiment execution still needs macOS `sandbox-exec`.

## Install

From npm:

```sh
npm install -g @ashlr/phantom
phm --version
```

From source, [`install.sh`](https://github.com/ashlrai/phantom/blob/master/install.sh) checks Node,
installs dependencies, builds `dist/`, and symlinks `phm` and `ashlr` into `~/.local/bin`:

```sh
git clone https://github.com/ashlrai/phantom.git
cd phantom
./install.sh
phm --version      # re-open your shell if ~/.local/bin is not yet on PATH
```

On Windows, from PowerShell, without an Administrator prompt:

```powershell
irm https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install.ps1 | iex
```

On Linux or macOS, the same checks are in `scripts/install-release.sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/ashlrai/phantom/master/scripts/install-release.sh | bash
```

That script detects the architecture, downloads a published per-OS release asset when one exists, and otherwise installs the npm package after verifying its sha512 integrity (and a GitHub attestation when `gh` is installed). It puts `phm` on your user PATH, runs `phm doctor`, and on Linux runs `phm daemon install`.

The per-user daemon:

| OS | Manager | Register | Stop |
| --- | --- | --- | --- |
| macOS | launchd | `phm authority resident start` | `phm authority resident stop` |
| Linux | systemd --user | `phm daemon install` | `phm daemon uninstall` |
| Windows | schtasks, per-user logon task, limited and interactive | `phm daemon install` | `phm daemon uninstall` |

`phm daemon service-status` reads the service. It does not start a SYSTEM service and it does not ask for Administrator.

Without changing PATH: `npm ci && npm run build`, then `node bin/ashlr --version` (or `npm run dev -- --version` via tsx).
For a pinned source install, see [versioned self-swap](https://github.com/ashlrai/phantom/blob/master/docs/SELF-SWAP.md).

## First run

```sh
phm init        # writes ~/.ashlr/config.json, creates ~/.ashlr/genome, links ~/.local/bin/ashlr
phm doctor      # checks Node, git, config, providers and MCP registration; --fix auto-fixes
phm verse       # opens the workbench — keep the printed tokens private
```

`phm init --wire` also registers the gateway in detected agents. `phm preflight` checks readiness without writing.
`phm onboard` guides activation: preflight → enroll one repo → dry-run plan → inbox review.
See [Quickstart](QUICKSTART.md) for first chat and [first local session](VERSE.md#first-local-session) for a console tour.

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

Source PATH shims: `~/.local/bin/phm` and `~/.local/bin/ashlr`. See the [full state map](https://github.com/ashlrai/phantom/blob/master/docs/RELIABILITY.md#where-state-lives).

## Connect Claude Code and Codex over MCP

`phm mcp` serves Phantom's tools and server-prefixed tools from `~/.ashlr/settings.json` over stdio.
Register and probe companions, then add `ashlr-hub` to each client. `phm wire` backs up config and is idempotent;
`phm wire status` reports detection and registration without writing:

```sh
phm mcp ecosystem --write
phm mcp doctor
phm wire claude     # merges "ashlr-hub" into ~/.claude.json
phm wire codex      # runs codex mcp add ashlr-hub -- ashlr mcp
phm wire all        # every detected client (claude, codex, cursor)
```

`phm mcp install claude` writes the same `~/.claude.json` entry using the absolute path to this install's `bin/ashlr`.
To register manually, add this entry under `mcpServers` in the client's config:

```json
"ashlr-hub": { "command": "ashlr", "args": ["mcp"] }
```

Restart the agent to reload MCP servers. For companion setup, see [one connection for every agent](COMPANIONS.md#one-connection-for-every-agent).

## Upgrade

- Release directory (`~/.local/share/ashlr/releases/<sha>`): `phm update` verifies SHA-512 and, if `gh` is installed, the npm tarball's attestation.
  It smoke-tests the candidate, swaps `current`, and pauses and restarts active launchd services. Failure restores links; the prior release stays on disk.
  `phm update --json` returns `from`, `to`, `verified`, `rolled_back` and `log_line` (appended to `~/.ashlr-runs/installs.log`).
  `--check` leaves the install unchanged.
- Source checkout: `phm update` (alias `phm upgrade`) refuses a dirty tree; otherwise it runs `git pull --ff-only`, `npm install` and `npm run build`,
  then checks the `~/.local/bin` symlink and smoke-tests `help`. `phm update --check` is read-only.
  Equivalent by hand: `git pull --ff-only && npm ci && npm run build && ./install.sh`.
- npm install: `phm update` checks the registry and prints `npm install -g @ashlr/phantom@latest`; `--yes` runs it.
- A running console picks up the new build on next start; re-open `phm verse`.

## Uninstall

1. Ctrl-C `phm verse`. Inspect any service with `phm daemon service-status`, stop it with `phm daemon stop`, and remove it with `phm daemon uninstall`.
   On macOS under a standing grant, run `phm authority resident stop` first. `phm onboard --rollback <repo>` reverses guided activation.
2. Run `codex mcp remove ashlr-hub`; delete the `ashlr-hub` key under `mcpServers` in `~/.claude.json` and `~/.cursor/mcp.json`.
3. Run `npm uninstall -g @ashlr/phantom` or, for source installs, `rm ~/.local/bin/phm ~/.local/bin/ashlr` and delete the checkout.
4. Remove all local state (config, enrollments, inbox, sandboxes, audit, and genome): `rm -rf ~/.ashlr`.

## See also

- [Agent operations](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-OPERATIONS.md#where-state-lives) for the cold-start checklist; `phm docs --agent --json` prints your binary's command registry.
- [Autonomy setup](AUTONOMY-SETUP.md) before granting the resident runtime standing authority; [Automatic work](AUTOMATIC-OUTCOMES.md) for readiness.
