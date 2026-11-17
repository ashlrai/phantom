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
- Generated adapters (pinned, committed): [`capabilities/generated/`](https://github.com/ashlrai/phantom/tree/master/capabilities/generated).
- CLI: `phm caps list`, `phm caps validate`, `phm caps generate`.

## Execution adapters

`surface.adapter` selects the companion config format. The optional
`surface.dispatch` selects execution: `engine`, `hosted`, or `unavailable`.
Omitting it means unavailable. A desktop config format never commissions a
CLI launch. Engine dispatch requires an existing engine on a directly reachable
CLI or local-runtime surface, with the corresponding CLI or API transport.
Hosted dispatch requires a hosted-only surface and retains its hosting edges.

Inspect a selected pair without launching anything:

```sh
phm caps route --surface codex-cli --model gpt-6.1-sol --json
phm caps route --surface glm-lite --model glm-5.3 --json
```

[`caps/dispatch.ts`](../src/core/caps/dispatch.ts) resolves the pair and
rejects catalog models belonging to another engine, even within a shared lane.
`planSurfaceModelDispatch` materializes direct routes using the selected
provider model id and the transport adapters in
[`run/engine-registry.ts`](../src/core/run/engine-registry.ts).
The existing `buildEngineCommand` uses those same adapters. Configured CLI
engines require no provider branch. Selected Grok seat preparation and the
llama-server API-only invariant stay inside the adapter boundary.

A route is a plan, not admission, a lease, a sandbox, a model call, permission
to spend, or an installed-provider check. Hosted routes are receipts for the
host adapter; the direct command planner refuses to bypass that host.
Uncommissioned desktop, cloud and bot surfaces refuse execution explicitly.

### Remaining provider branches and migration plan

This inventory covers the engine, sandbox, fleet router and Mac dispatcher
paths inspected for RQ-ADAPTER-NEUTRAL-1. It does not claim all provider branches
throughout the repository have been removed.

| Location | Remaining behavior | Next migration |
| --- | --- | --- |
| `run/engines.ts`, `engineInstalled` | Builtin availability and llama-server endpoint probe | Adapter-owned availability probe, preserving timeout and runtime ownership. |
| `run/engines.ts`, spawn and output handling | Codex reasoning-config recovery, CLI stream-family detection, Claude rate-limit capture and native-engine protocol hints | Adapter-owned retry and observation hooks, retaining bounded retries, credential stripping and process cancellation. |
| `run/engine-registry.ts`, configuration folds and `registryEngineForFleetEngine` | Provider convenience config, protected engine specs and fleet lane aliases | Move folds into preparation adapters and replace lane aliases with explicit surface ids. Keep protected Grok and Devin specs immutable. |
| `run/harness-dispatch.ts` | Claude, Codex and Grok effort flags; local API sampling carriers | Adapter-owned tuning functions with existing clamping and unsupported-field receipts. |
| `run/orchestrator.ts` | Grok seat config, builtin sandbox refusal, Grok seat forwarding and Devin resume binding | Carry the resolved adapter identity and seat through the run request; retain sandbox and resume gates. |
| `run/sandboxed-engine.ts` | Claude MCP argv and API gateway, Grok profile, Codex capacity, local context and host verification | Adapter-owned invocation and capability hooks. Preserve all current admission, credential and confinement checks. |
| `fleet/dispatch-router.ts` | Provider grant, overflow, reserve, model and installed-lane selection | Feed selected surface/model receipts into seat admission. Move resource policies into adapter metadata without changing the budget or producer-role gates. |
| `contrib/mac/dispatchd.py`, failure and usage parsing | Claude and Devin result parsing, Codex auth/usage distinctions | Provider observation adapters emitting the existing normalized verdicts. |
| `contrib/mac/dispatchd.py`, slot and admission policy | oMLX cap/health, local-mid limits, Claude API pacing, Devin failure-spike reduction, quota waste boosts | Resource policy adapters backed by measured account snapshots. Keep included-only admission and holds. |
| `contrib/mac/dispatchd.py`, batching and launch | Claude batch tier, local Python runner vs shell launcher, Codex family metrics | Replace the lane switch with a surface/model launch receipt after Security reviews the existing staged dispatcher work against pin `d5acb03d`. |

No dispatcher or launcher source is changed by this implementation, so there is
no new pinned dispatcher diff to install or layer over the existing Security
package. The Mac cutover depends on Security reconciling that package and
commissioning a reviewed host adapter. No live installation is performed here.

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
