# Agent operations guide

A cold-start checklist for a coding agent that must build this repository, or
install and operate Phantom. Every command here exists in the current source
(`phm --help`, `phm help <topic>`, `phm <command> --help`); where a capability
is gated or unverified, this guide says so. The binary you run is the authority:
an older install may lack commands described here.

`phm` and `ashlr` are the same binary (`package.json` `bin`). Help text uses
either name.

## 1. Working on this repository

| Need | Command |
| --- | --- |
| Node version | `>=22.15.0` (`package.json` `engines`) |
| Install dependencies | `npm ci` |
| Build `dist/` (CLI, assets, web console, build identity) | `npm run build` |
| Run the CLI from source, no build | `npm run dev -- <command>` or `npx tsx src/cli/index.ts <command>` |
| Run the built CLI | `node bin/ashlr <command>` (shim that imports `dist/cli/index.js`) |
| Install the source build on `PATH` | `./install.sh` (builds, symlinks `bin/ashlr` into `~/.local/bin`) |
| Type check (backend + web) | `npm run typecheck` |
| Lint (ESLint + real-I/O lane + Verse sync-I/O guards) | `npm run lint` |
| Backend tests | `npm test` (all), `npx vitest run test/<file>.test.ts` (focused) |
| Backend tests with isolated homes and a runtime cap | `npm run test:ci -- <files>` |
| Web console tests | `npm run test:web` |
| Safety invariant suites | `npm run test:invariants` |
| Documentation links and anchors (offline) | `npm run check:docs` |
| Fast local gate: build, static checks, related tests, smoke set | `npm run gate` (`-- --base <ref>`, `-- --json`) |
| Full gate: complete backend and web suites | `npm run gate:full` |
| Release-readiness subset | `npm run check:release` |

`npm run gate` writes to `.ashlr-gate/` and `dist/`. It selects tests through
the import graph, so a test that reads a changed file as text is not selected;
name it explicitly or use `gate:full`. Neither replaces hosted CI or the
[release guide](RELEASING.md).

**Tests.** Backend suites live in `test/` and are named after the milestone or
release that introduced them: `test/m<N>.<topic>.test.ts`, invariant suites
`test/h<N>.*.test.ts`, and `test/<topic>-<release>.test.ts`. Web tests sit next
to their components as `src/web-ui/**/*.test.{ts,tsx}`. Tests that do real I/O
must be listed in `test/config/realio-lane-membership.mjs` (`npm run lint`
checks this). Every test runs with an isolated `HOME` (`test/setup/home.ts`),
and writes under the real `~/.ashlr` fail the test.

**Layout.** `src/cli/` holds thin argv dispatchers, one file per command group;
`src/core/` holds the logic; `src/web-ui/` the React console; `desktop/` the
desktop app; `scripts/` build, gate and check tooling. See
[CONTRIBUTING.md](../CONTRIBUTING.md#project-layout) and
[ARCHITECTURE.md](ARCHITECTURE.md).

**Docs.** The map is [docs/README.md](README.md). `scripts/check-documentation.mjs`
checks the operator entrypoints in its `OPERATOR_DOCUMENTATION` list. Each of
those (except `README.md`) must also appear in `package.json` `files`
(`test/documentation-navigation.test.ts`). A packaged guide must link to an
unpackaged one through a `https://github.com/ashlrai/phantom/blob/master/...`
source link, which the checker resolves locally.

## 2. Installing and running Phantom

```sh
npm install -g @ashlr/phantom
phm --version
phm doctor            # health check; exits 1 when any check fails
phm verse             # console at http://127.0.0.1:7777/verse/
```

- `phm verse [--port N] [--no-open] [--json]` binds `127.0.0.1` only (default
  port 7777) and prints a read token and a mutation token. Keep both private.
  `--json` prints them too, so do not log that output.
- `phm doctor [--json] [--fix]` checks Node, git, config, Phantom Secrets, Locus,
  local providers and MCP registration, and prints a `fix:` line for each problem.
- `phm init [--wire] [--yes] [--json]` is idempotent onboarding. It writes the
  config, creates `~/.ashlr/genome`, symlinks `ashlr` into `~/.local/bin`, and
  with `--wire` registers the MCP gateway in detected editors. It has no
  `--help`: any invocation runs it.
- `phm preflight [--json]` is a read-only readiness check (exit 0 ready, 1 blocked).
- `phm onboard [--yes]` walks through the first safe activation (preflight, enroll
  one repo, dry-run plan, inbox). `phm onboard --rollback <repo> [--kill]` undoes it.
- `phm setup` and `phm worker setup` are currently unavailable and refuse
  before changing anything.
- `phm docs --agent [--json]` prints the command registry for agents.

For the desktop app and the first useful turn, follow the
[Quickstart](QUICKSTART.md) and [desktop/README.md](../desktop/README.md).

### MCP server

`phm mcp` runs the MCP aggregation gateway on stdio. Its subcommands are `list`,
`doctor` (exit 1 when a required server is down), `install <claude|ashlrcode>`
and `ecosystem [--write]`.

`phm wire [claude|codex|cursor|all] [--config <path>] [--json]` registers the
gateway as server `ashlr-hub` with command `ashlr` and args `["mcp"]`. It backs
up the target config first and is idempotent.

| Client | Default config | How `wire` writes it |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | JSON merge into `mcpServers` |
| Codex | `~/.codex/config.toml` | runs `codex mcp add ashlr-hub -- ashlr mcp` |
| Cursor | `~/.cursor/mcp.json` | JSON merge into `mcpServers` |

Without a target, or with `all`, it wires only the editors it detects. To test
without touching real configs, pass one explicit target with `--config`, for
example `phm wire claude --config /tmp/x/.claude.json` or
`phm wire codex --config /tmp/x/config.toml` (Codex still needs the `codex` CLI).
`phm wire --claude-md` prints a CLAUDE.md snippet and writes nothing.

### Daemon

`phm daemon status|doctor|pause|resume|stop|service-status`. In this build,
`daemon start --once` refuses before taking any action because the compiled
daemon trust roots are empty. `daemon start --once --dry-run` only plans, and
`daemon install` is withheld. `phm authority resident start|stop|status` manages
the resident daemon under an active grant. See
[RESIDENT-RUNTIME.md](RESIDENT-RUNTIME.md).

### Where state lives

Everything is under `~/.ashlr/`. Verified paths:

| Path | Contents |
| --- | --- |
| `config.json` | configuration (`phm config path`, `phm config effective --json`) |
| `KILL` | the global kill switch / Stop marker |
| `account-connections/connections.json` | native account roster that Verse seats come from |
| `authority/ledger.jsonl` | hash-chained authority ledger |
| `manager/<ts>.json` | `phm manager` reports |
| `logs/` | supervised local-runtime stdout and stderr |
| `daemon.launchd.out.log`, `daemon.launchd.err.log` (macOS), `daemon.systemd.log` (Linux) | daemon service output |
| `fleet/mirrors/` | the fleet's own mirror clones (`phm mirror`) |

[RELIABILITY.md](RELIABILITY.md#where-state-lives) lists the rest
(`enrollment.json`, `daemon.json`, `inbox/`, `sandboxes/`, `audit/`).

## 3. Operating

| Group | Purpose (from `phm help`) |
| --- | --- |
| `phm orient [--repo <r>] [--json]` | Read-only session-start context: memory hits, health, backlog, pending proposals |
| `phm enroll list\|add\|remove\|kill` | Repos open to autonomous work, plus the global kill switch |
| `phm backlog [refresh]` | Scored work queue across enrolled repos |
| `phm inbox [show\|approve\|submit\|reject] <id>` | Approval gate for proposals; `approve` applies to a local branch, `submit` hands off to a protected PR and never merges main |
| `phm goals add\|plan\|advance\|status\|pause\|resume` | Objectives decomposed into milestones; `advance` runs a sandboxed, proposal-only swarm on an enrolled repo |
| `phm goal "<objective>"` | One owner-invoked plan plus one proposal-only advance |
| `phm run "<goal>"` / `phm swarm "<goal>"` | Local agent run / contracts-first multi-agent run (`run --engine <id>`; both accept `--allow-cloud`) |
| `phm fleet status\|watch\|direction\|doctor\|scorecard\|oversight` | Read-only fleet snapshot, direction report, engine readiness and quality metrics |
| `phm manager [--apply-rejects]` | Judges pending proposals; shadow mode by default, never merges |
| `phm leader show\|run\|tick\|say\|thread\|approve\|veto\|directives` | The Leader: memos, actions, directives and veto ([LEADER.md](LEADER.md)) |
| `phm improve propose [--open-pr --repo <dir>]` | Evidence-backed self-improvement proposals; `--open-pr` opens draft PRs from an isolated worktree and never merges or deploys |
| `phm cloud ...` / `phm devin ...` | Claude Code cloud and Devin lanes ([CLOUD.md](CLOUD.md), [DEVIN.md](DEVIN.md)) |
| `phm automations ...` | Turn triggers (labels, red CI, schedules, webhooks) into fleet tasks |
| `phm website status\|auto\|pause\|off` | Inspect or pause automatic phm.dev publication |
| `phm resources [--json]`, `phm usage` | Per-backend capacity and usage, read-only |
| `phm audit [N] [--json]` | Tail the append-only audit trail |

### Stop and pause

| Control | Effect |
| --- | --- |
| `phm authority stop [--no-wait]` / `clear-stop` | Engages Stop (`~/.ashlr/KILL`): halts running agents and cancels armed merges. Clearing is written to the ledger first. |
| `phm authority revoke [--reason <text>]` | Stop, set autonomy off, and require a new signed grant to resume |
| `phm authority switch off\|propose\|autonomous` | Lowers autonomy at once; can raise it only as far as the grant allows |
| `phm fleet pause` / `phm fleet resume` | Engage or release the global kill switch (idempotent) |
| `phm enroll kill on\|off` | Same global kill switch |
| `phm daemon pause` / `resume` | Halt autonomous dispatch only |
| `phm daemon stop` | Orderly shutdown; also sets the global kill switch |
| `phm website pause` | Pause automatic site publication |

### Authority

`phm authority status [--json]` shows grant state, the switch, Stop, the
rollout stage, the ledger chain and custody. Grants (`authority grant`,
`re-approve`) are signed with Touch ID through custody and verify only against
the standing-grant trust roots compiled into the release
(`src/core/authority/trust-roots.ts`). The separate daemon and conductor
activation trust roots are empty, so permit-based daemon and conductor
execution stays dormant. `phm authority setup --dry-run` previews
Phase 0. Agents do not sign grants. The policy reserved for the owner is in
[AGENTS.md](../AGENTS.md). Design and procedures:
[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md) and [AUTHORITY.md](AUTHORITY.md).

## 4. Native engines

There are two registries:

- **Verse chat routing** (`ROUTABLE_ENGINES` in
  `src/core/verse/multimodel/advisor.ts`): `claude`, `codex`, `devin`, `grok`,
  `local`. Native seats (claude, codex, grok) come from
  `~/.ashlr/account-connections/connections.json`. Local seats are Ollama
  models: the base URL is `cfg.models.ollama`, otherwise the default. Devin
  chat seats are separate: a cloud seat, and a CLI seat that is listed when the
  `devin` binary is found.
- **Fleet and run engines** (`src/core/run/engine-registry.ts`). The fleet
  dispatches only to `cfg.foundry.allowedBackends`, which defaults to
  `["builtin"]`. `phm fleet init [--write]` prints or merges a starter `foundry`
  block ([FOUNDRY-CONFIG.md](FOUNDRY-CONFIG.md)). `phm fleet doctor [--json]`
  probes each allowed engine.

How `fleet doctor` decides readiness (`src/core/fleet/engine-readiness.ts`):

| Engine id | Kind | Detected by | Auth signal |
| --- | --- | --- | --- |
| `builtin` | built-in | always present | always ready |
| `claude` | CLI | `claude` on `PATH` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` set, or `~/.claude/credentials.json` exists |
| `codex` | CLI | `codex` on `PATH` | `codex login status` output |
| `grok-cli` | CLI | `grok` on `PATH` | not probed |
| `devin-cli` | CLI | `devin` on `PATH` | not probed by `fleet doctor` |
| `aw`, `ashlrcode` (`ac`), `hermes`, `opencode` | CLI | binary on `PATH` | not probed |
| `claude-api`, `grok`, `kimi`, `nim`, `meta-muse`, `openai-compat` | API | env key set (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `NVIDIA_NIM_API_KEY`, `MODEL_API_KEY`, `OPENAI_COMPAT_API_KEY`) | a set key counts as ready |
| `local-coder` (Ollama), `llama-server` | local API | loopback `/models` lists the configured model ID (`OLLAMA_BASE_URL`, `LLAMA_SERVER_BASE_URL`) | not applicable |

**Not verified by these probes:** that a credential is valid or unexpired, that
a model completes a request, quota or plan entitlement, and auth for any CLI
marked "not probed". A key that is present, or a `codex` that reports logged
in, can still fail at runtime. For per-account capacity, use
[RESOURCE-POOLS.md](RESOURCE-POOLS.md) and `phm resources`. For local models,
use [LOCAL-FLEET.md](LOCAL-FLEET.md), `phm models` and `phm local-runtime status`.

## 5. Troubleshooting

| Symptom | Command |
| --- | --- |
| Not sure what is wrong | `phm doctor` (then `phm doctor --fix` for safe fixes), `phm preflight` |
| `phm` not found after install | `phm doctor` checks `~/.local/bin` on `PATH`; from source run `./install.sh` |
| Agent does not see Phantom tools | `phm mcp doctor`, `phm mcp list`, then `phm wire <client>` |
| No local provider reachable | `phm models`, `phm models start`, `phm local-runtime status\|logs` |
| An engine is not ready | `phm fleet doctor` and its `fix:` line |
| `daemon status` reports a state issue | `phm daemon recover-state --dry-run --expected-sha256 <sha256>`, then `--execute --plan-id <uuid> --plan-sha256 <sha256> --authorize <plan-sha256>` to quarantine; resolve the quarantine with `phm daemon resolve-state --dry-run --quarantine-plan-id <uuid> --quarantine-receipt-sha256 <sha256>` (see `phm daemon <sub> --help`) |
| Daemon claims running but is not | `phm daemon doctor`, then `phm daemon doctor --clear-stale` |
| Goals stuck in progress with no proposal | `phm goals recover-stale --dry-run` |
| Leftover sandbox worktrees | `phm sandbox list`, `phm sandbox gc` |
| Log roots using too much disk | `phm steward disk` (dry run; `--apply` deletes expired or over-quota plain logs and gzip-archives cold Codex and Claude sessions to `~/.ashlr/archive`; files modified in the last 24 hours are untouched) |
| Ledger integrity questions | `phm authority ledger verify` |
| Safety invariants | `phm verify-safety` |
| Ledger-specific diagnosis | `phm fleet evidence doctor <source> [--json]` |
| Undo a first activation | `phm onboard --rollback <repo> [--kill]` |

For more failure modes and their recovery, see
[RELIABILITY.md](RELIABILITY.md#failure-modes--recovery).
