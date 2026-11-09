# Architecture knowledge map

This is a source navigation aid, not evidence that every integration is active.
For the directory inventory and drift check see [Code map](CODEMAP.md); for
runtime and trust boundaries see [Architecture](ARCHITECTURE.md).

| Module | Responsibility | Flow and extension point |
| --- | --- | --- |
| `bin/ashlr`, `src/cli/` | CLI entry, command dispatch, argument handling and presentation | `bin/ashlr` loads the compiled CLI; `src/cli/index.ts` dispatches to handlers. Add behavior in core and wire a thin handler, help and completions. |
| `src/api/` | Public SDK entry points and HTTP adapters | Package exports curate core surfaces; check the relevant export and compatibility before extending the API. |
| `src/core/web/`, `src/core/verse/`, `src/web-ui/` | HTTP server, console services and browser UI | `src/cli/verse.ts` starts services; `web/server.ts` routes requests through web and Verse handlers and serves the UI. Extend the relevant handler and frontend component together, preserving session boundaries. |
| `src/core/mcp-gateway.ts`, `src/core/mcp/`, `src/mcp/` | MCP gateway, native tools and separate fleet server | The gateway loads configuration and policy, exposes native tools and routes downstream tools. Extend native registration or a fleet adapter as appropriate; review policy and authorization paths. |
| `src/core/fleet/`, `daemon/`, `routing/`, `queue/`, `resources/` | Fleet state, resident operation, routing, queue and capacity | CLI adapters call these subsystems; the daemon coordinates bounded phases. Extend the owning subsystem and its contract rather than assuming one scheduler owns all work. |
| `src/core/run/`, `sandbox/`, `swarm/`, `spec/` | Run execution, isolation and agent work | Run handlers orchestrate execution and related adapters. Check sandbox and execution contracts before adding an engine or changing process behavior. |
| `src/core/agents/`, `comms/` | Agent bus and communication | Bus schemas and providers define coordination; claims do not grant execution authority. Extend the schema and provider contract together. |
| `src/core/authority/`, `policy/`, `security/` | Grants, policy and security boundaries | Execution and integration paths consult their own gates. Locate the actual enforcement point before changing a policy; a documentation claim is not an authorization. |
| `src/core/universe/` | Experiments, candidates, evaluation and delivery | Universe CLI adapters invoke core flows; extend the relevant evaluator or contract and preserve evidence boundaries. |
| `src/core/memory/`, `knowledge/`, `ask/`, `index-engine.ts` | Stored knowledge, indexing and retrieval | CLI and other consumers use these components for context. Extend the relevant storage or retrieval path and its tests. |
| `src/core/integrations/`, `connectors/` | External tool and account integration | Connectors and adapters mediate external systems; retain scoped access and existing credential custody. |
| `src/core/release/`, `local-runtime/`, `scripts/` | Release evidence, local runtime and build/verification automation | Sanctioned workflows and scripts drive release steps; consult [Releasing](RELEASING.md) and the applicable contract before changes. |
| `src/fleet/`, `src/tui/`, `src/raycast/`, `desktop/` | Replay, terminal, Raycast and desktop adapters | These are distinct entry surfaces; follow their local documentation and tests when extending them. |

Dependencies are not strictly layered: core subsystems call one another and some
adapters live in core. Follow imports and tests for the exact path being changed.
Documentation navigation is indexed by task in [the docs index](README.md).
