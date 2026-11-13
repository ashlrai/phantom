# Capability registry

The capability registry is the single in-repo source of truth for the MCP
servers, skills, plugins, CLIs, connectors and account references that agent
surfaces load, and for the surfaces and models the router pairs them with
(PHANTOM-OS-1, PR 1).

- Data: [`capabilities/registry.v1.json`](../capabilities/registry.v1.json)
  (`schema: "caps.registry.v1"`, `version: 1`).
- Schema and validation: [`src/core/caps/schema.ts`](../src/core/caps/schema.ts),
  [`src/core/caps/registry.ts`](../src/core/caps/registry.ts).
- Adapter generator: [`src/core/caps/generate.ts`](../src/core/caps/generate.ts).
- Generated adapters (pinned, committed): [`capabilities/generated/`](../capabilities/generated/).
- CLI: `phm caps list`, `phm caps validate`, `phm caps generate`.

The registry is data only. Loading it starts no process, resolves no
credential, contacts no provider and grants no authority.

## Surfaces, models and hosting edges

A surface is where an agent runs: Claude Code, Claude Desktop, Codex CLI and
Desktop, Devin CLI and Desktop, Cursor Desktop and cloud sessions, Grok Build,
Grok Bot Desktop, Gemini CLI, Copilot CLI, and local oMLX/Qwen. A model is what
the agent thinks with. Surfaces and models are separate record types. The
router chooses a `(surface, model)` pair, and a pair is valid only when both
are in the same lane. An id may name a surface or a model, but not both.

Fable 5.2 (`claude-fable-5-2`) is a Claude model in the `claude` lane, beside
Opus and Sonnet. It counts against the `claude-max-weekly-fable` allowance. It
is not a surface, an agent or an app. The Weyv lead is a session: Claude Code
pinned to Fable 5.2 (`sessions[].id = "weyv-lead"`).

The registry does not redefine the router. A surface's `engine` must be an id
in `src/core/run/engine-registry.ts`. A model's `catalogId` must be an entry in
`KNOWN_MODELS` (`src/core/run/model-catalog.ts`), and its `providerModelId` must
match that entry. Use `catalogId: null` for a model Phantom does not route.

Hosting relationships are first-class `hosting` edges `{ host, guest, via }`.
Devin CLI and Devin Desktop host GLM Lite, Cursor, Grok Build, Gemini, Copilot,
Qwen and Codex. A `hostedOnly` surface is reachable only through a host, and
the pair resolution reports the host path in `via`. Validation rejects
self-hosting, unknown ends, duplicate edges, cycles and orphan hosted-only
surfaces.

## Security rules enforced by validation

Every rule below is checked by `validateCapsRegistry` and covered by
`test/caps-registry.test.ts`.

| Rule | Enforcement |
| --- | --- |
| Control backends | Allowed: `ax`, `applescript`, `jxa`, `shortcuts`, `app-cli`, `url-scheme`, `cdp-loopback`, `playwright-loopback`. CDP and Playwright need `profile: "per-run"` and `bind: "127.0.0.1"`. `tcc-db`, `tcc-grant`, `app-db`, `scrape` and `screen-scrape` are refused by name. |
| Accounts are references | An account has `provider`, `store`, `credentialName` (an upper-case vault name) and `scopes`. Objects are closed, so a value field cannot be added. The whole document is screened for secret-shaped text before parsing, and diagnostics never echo input values. |
| Local models | A `local-runtime` surface must declare `bind: "127.0.0.1"`, `keyForwarding: false` and an `egressAllowlistRef` that names a defined allowlist. Open egress cannot be represented. |
| Sensitivity flags | Every capability declares `external_send`, `spend` and `delete` explicitly. Effects that imply a flag (`send-mail`, `send-message`, `post-slack`, `post-public`, `spend`, `plan-change`, `delete-data`) must set it. A set flag requires the matching hard-limit gate: `outside-send`, `money` or `destroy-data`, the constitution's limits (`HardLimit` in `src/core/fleet/needs-mason-triage.ts`). |
| Auto-file metadata | `autoFile.fields` is a closed enum (`capability-id`, `surface-id`, `model-id`, `job-id`, `repo`, `timestamp`, `outcome`, `duration-ms`, `error-code`). No field can hold screen contents or a secret value. |

Gated capabilities (any sensitivity flag set) are never loaded directly by a
generated adapter. They are listed in the manifest's `gated` list with their
gate ids. Claude Code adapters also deny them explicitly (`mcp__<id>`, or
`Bash(<cli> <args>:*)` for a CLI), so the existing hard-limit gates are the only
path to them.

## Adapter generation

`phm caps generate` emits per-agent configs from the registry. No config is
copied by hand.

| Format | Output |
| --- | --- |
| Claude Code and Claude Desktop | `claude-code/<surface>.mcp.json`, `claude-code/<surface>.settings.json` |
| Fable-as-Claude-model sessions | `sessions/<session>.settings.json` (pinned `model`), `sessions/<session>.mcp.json` |
| Codex | `codex/<surface>.config.toml` (`[mcp_servers.*]`, `env_vars` by name) |
| Devin and hosted surfaces | `devin/<surface>.json` with one `hosted[]` entry per guest surface |
| Cursor | `cursor/<surface>.mcp.json` |
| Grok Build | `grok-build/<surface>.json` |
| Gemini | `gemini/<surface>.settings.json` |
| Copilot | `copilot/<surface>.mcp.json` |
| Local models (oMLX/Qwen) | `local-model/<surface>.json` (bind, key forwarding, egress allowlist) |

Credentials appear only as references in each host's own expansion syntax
(`${NAME}`, `${env:NAME}`, `$NAME`, Codex `env_vars`). Output is deterministic:
keys are sorted and entries ordered by id, so each artifact has a stable
sha256.

Output goes only to a subdirectory of the current worktree (by default
`capabilities/generated/`) or to `~/.ashlr-runs/staged/`. The generator
refuses a path in `~/.codex`, `~/.claude`, `~/.cursor`, `~/.gemini`, `~/.devin`,
`~/.config`, `~/Library` or another live agent config directory. It also
refuses repo-local live config paths such as `.claude/`, `.cursor/`, `.vscode/`
and `.mcp.json`, and symlinks that resolve into any of those directories.
Installing an adapter into a live agent is a separate step for the owner.

`phm caps generate --check` compares the output directory with a fresh
generation and writes nothing. The test suite runs the same check against
the committed `capabilities/generated/`. After a registry change, run
`phm caps generate` and commit the result.

## Pinned artifacts and pin-stage

Generated adapters are pinned artifacts:

1. Each artifact's sha256 is recorded in `manifest.json` and in `SHA256SUMS`
   (`sha256sum` format).
2. `bundleSha256` is the sha256 of `SHA256SUMS`. `registrySha256` is the
   sha256 of the canonical registry that produced the bundle.
3. `phm caps generate --pin-stage` writes the bundle to
   `~/.ashlr-runs/staged/caps/<bundleSha256>/`. That directory is the hand-off
   to Security's pin-stage tool, SEC-PIN-STAGE-TOOL-2 (`pin_stage_lib`
   fe77a6a8), which verifies it with `shasum -a 256 -c SHA256SUMS` before
   pinning. The manifest's `pinStage` block records the tool, the library
   revision and the staged directory.

Phantom does not invoke the pin-stage tool and does not edit Security's pinned
`bin/` files. Any helper proposed for that tool is staged under
`~/.ashlr-runs/staged/` for a Security pin.

## Adding an entry

1. Edit `capabilities/registry.v1.json`.
2. Run `phm caps validate`.
3. Run `phm caps generate` and commit `capabilities/generated/`.

The companion MCP launch specs must match the repository's `.mcp.json`. A test
enforces this so the two cannot drift.

Incompatible schema changes need a new `schema` id and file (`caps.registry.v2`).
Validators accept only the exact version.
