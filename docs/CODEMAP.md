# Source code map

This is a navigation map of the checked-in source, not a promise that every
runtime is active. Start with [Architecture](ARCHITECTURE.md) for runtime and
security boundaries and [Contributing](../CONTRIBUTING.md) for the workflow.
Use `rg` to find the command, endpoint, type or contract before changing it.

## Entry points and dependency direction

| Entry | Follow it to |
| --- | --- |
| `bin/ashlr` (`phm` and `ashlr`) | `dist/cli/index.js`, compiled from `src/cli/index.ts`; command handlers are in `src/cli/`. |
| `npm run dev -- <command>` | `tsx src/cli/index.ts`; the dispatcher and handlers import implementations from `src/core/` and other source areas. |
| SDK | `package.json` exports point to `src/api/index.ts`, `core.ts`, `types.ts`, `plugin.ts`, and `src/core/universe/index.ts` after compilation. The API modules curate/re-export core surfaces. `src/api/graph-http.ts` and `github-webhook.ts` also implement HTTP adapters. |
| `phm serve` / `phm verse` | `src/core/web/server.ts` → `web/api.ts` and `core/verse/`; the server serves the Vite console built from `src/web-ui/main.tsx`. HTTP is the boundary between browser and backend. |
| `phm mcp` | `src/core/mcp-gateway.ts`; `src/mcp/` includes the separate fleet server and its tool adapters. See [agent MCP](AGENT-MCP-CLI.md). |
| `phm tui` / `dash` | `src/tui/app.ts` and `render.ts`, backed by core dashboard data. |
| Raycast | `src/raycast/` is a separate extension package; commands live in `src/raycast/src/`. |
| Desktop | `desktop/` wraps the console and CLI sidecar; see [desktop guide](../desktop/README.md). |

These arrows describe observed imports and runtime calls, not an enforced layer
rule. Core subsystems import each other, and some adapters live in core. For
example `core/web/server.ts` imports both `core/web/api.ts` and `core/verse/`;
`src/mcp/fleet-server.ts` imports fleet core modules and its sibling adapters.
Check actual imports for a change rather than assuming an acyclic architecture.

## Where to work

| Concern | Source starting points | Guide or contract |
| --- | --- | --- |
| Command dispatch and flags | `src/cli/index.ts`, `src/cli/args.ts`, matching `src/cli/<command>.ts` | [CLI reference](cli.md) |
| Configuration, shared types, disk state | `src/core/config.ts`, `src/core/types.ts`, `schema/` | [Architecture: home layout](ARCHITECTURE.md#the-ashlr-home-layout) |
| Runs, engines, sandboxes and swarms | `src/core/run/`, `sandbox/`, `swarm/`, `spec/` | [Architecture](ARCHITECTURE.md), [mailbox engine](MAILBOX-ENGINE.md) |
| Fleet scheduling and execution | `src/core/fleet/`, `daemon/`, `routing/`, `queue/`, `resources/` | [Fleet API](FLEET-API.md), [queue](QUEUE.md), [resource pools](RESOURCE-POOLS.md) |
| Session recording/replay and risk | `src/fleet/` (distinct from `src/core/fleet/`) | [Replay boundary](../src/fleet/README.md) |
| Diff classification | `src/planning/triviality.ts` | Callers and tests found via `rg classifyDiff` |
| Agent coordination and message contracts | `src/core/agents/`, `comms/` | [Agent Bus v2](AGENT-BUS.md#v2), [channels contract](contracts/CONTRACT-CHANNELS.md) |
| Authority, policy, security | `src/core/authority/`, `policy/`, `security/` | [Standing authority](STANDING-AUTHORITY.md), [runtime activation authority](RUNTIME_ACTIVATION_AUTHORITY.md) |
| Console backend | `src/core/web/`, `verse/` | [Verse](VERSE.md), [architecture runtime map](ARCHITECTURE.md#current-runtime-map) |
| Console frontend | `src/web-ui/main.tsx`, `app/`, `routes/`, `components/`, `hooks/`, `data/` | [Console layout](CONSOLE-LAYOUT.md); component tests are colocated |
| Candidate experiments | `src/core/universe/`, `src/core/resources/` | [Universe](ASHLR-UNIVERSE.md), [resource pools](RESOURCE-POOLS.md) |
| Memory, indexing, retrieval | `src/core/memory/`, `genome/`, `knowledge/`, `ask/`, `index-engine.ts` | [Memory](MEMORY.md), [memory foundation](MEMORY-FOUNDATION.md) |
| Integrations and MCP | `src/core/integrations/`, `connectors/`, `mcp/`, `mcp-gateway.ts`, `src/mcp/` | [Toolchain](AGENT-TOOLCHAIN.md), [connectors](CONNECTORS.md) |
| Release and local runtime | `src/core/release/`, `local-runtime/`, `scripts/` | [Releasing](RELEASING.md), [M523 release contract](contracts/CONTRACT-M523.md) |
| Metrics and observation | `src/core/metrics/`, `observability/`, `usage/`, `radar/` | [Lane health](LANE-HEALTH.md), [Radar](RADAR.md) |

Contract documents in `docs/contracts/` include milestone-specific acceptance
and security boundaries; their presence alone does not establish activation.
Search both source and `docs/contracts/` for a feature or milestone before
changing its behavior. Guides above are starting points, not a complete list of
contracts. Backend suites are in `test/`; use the affected suite and the
repository checks described in [Contributing](../CONTRIBUTING.md).

## Directory inventory

The following inventory is checked by `test/codemap-drift.test.ts`. When a
source or core directory is added, renamed or removed, update this inventory and
review the navigation prose and contract links above. The check catches directory
drift, not changed imports, individual files, semantics or contract coverage.

<!-- codemap:src:start -->
- `src/api/`
- `src/cli/`
- `src/core/`
- `src/fleet/`
- `src/mcp/`
- `src/planning/`
- `src/raycast/`
- `src/tui/`
- `src/web-ui/`
<!-- codemap:src:end -->

<!-- codemap:core:start -->
- `src/core/agents/`
- `src/core/ask/`
- `src/core/ask-flow/`
- `src/core/authority/`
- `src/core/automations/`
- `src/core/autonomy/`
- `src/core/autopilot/`
- `src/core/bridge/`
- `src/core/classify/`
- `src/core/cloud/`
- `src/core/comms/`
- `src/core/connectors/`
- `src/core/context/`
- `src/core/cos/`
- `src/core/daemon/`
- `src/core/dailyfix/`
- `src/core/decide/`
- `src/core/desktop/`
- `src/core/devin/`
- `src/core/digest/`
- `src/core/disk-maint/`
- `src/core/drive/`
- `src/core/driver/`
- `src/core/ecosystem/`
- `src/core/eval/`
- `src/core/fabric/`
- `src/core/fleet/`
- `src/core/foundry/`
- `src/core/generative/`
- `src/core/genome/`
- `src/core/github/`
- `src/core/goal-loop/`
- `src/core/goals/`
- `src/core/graph/`
- `src/core/improve/`
- `src/core/inbox/`
- `src/core/integrations/`
- `src/core/knowledge/`
- `src/core/learn/`
- `src/core/learning/`
- `src/core/lifecycle/`
- `src/core/local-eval/`
- `src/core/local-runtime/`
- `src/core/mcp/`
- `src/core/memory/`
- `src/core/metrics/`
- `src/core/observability/`
- `src/core/onboard/`
- `src/core/openai-agents/`
- `src/core/playbooks/`
- `src/core/plugins/`
- `src/core/policy/`
- `src/core/portfolio/`
- `src/core/proactive/`
- `src/core/quality/`
- `src/core/queue/`
- `src/core/radar/`
- `src/core/reasoning/`
- `src/core/receipt/`
- `src/core/release/`
- `src/core/resources/`
- `src/core/routing/`
- `src/core/run/`
- `src/core/sandbox/`
- `src/core/seams/`
- `src/core/security/`
- `src/core/spec/`
- `src/core/steward/`
- `src/core/strategy/`
- `src/core/swarm/`
- `src/core/teams/`
- `src/core/toolgraph/`
- `src/core/types/`
- `src/core/universe/`
- `src/core/usage/`
- `src/core/util/`
- `src/core/verse/`
- `src/core/vision/`
- `src/core/visual/`
- `src/core/web/`
- `src/core/website/`
- `src/core/workbench/`
<!-- codemap:core:end -->
