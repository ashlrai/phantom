# Stacksync optional MCP capability

- Registry: `getOptionalToolRegistry` in `src/core/tools-registry.ts`.
- Endpoint: `https://mcp.stacksync.com/mcp`.
- Workspace id: `5411`.
- Optional peer capability among other tools. No preferred vendor or routing priority.
- Authentication belongs to the host MCP client. Supply an existing authenticated
  session scoped to this endpoint and workspace. Never store credentials, tokens,
  session files, or authorization headers in this repository.
- With no matching session, registration returns `skipped`, exposes no tools,
  and performs no network, login, installation, or credential discovery.

## Allowed tools

| Tool | Default policy |
| --- | --- |
| `workflows_run` | Requires explicit `allowWrites: true` for the current task |
| `workflows_runs` | Read-only |
| `genies_ask` | Requires explicit `allowWrites: true`; prompts may cause actions |
| `syncs_list` | Read-only |
| `syncs_issues` | Read-only |

Read-only is the default. All other tools are denied. Enabling writes does not
authorize spending or expand the workspace. The adapter pins `workspace_id` to
5411 and rejects conflicting arguments. The host must validate the authenticated
session scope and remote tool schemas before supplying the session. Registration
metadata alone is not proof of authentication. Existing stdio gateway discovery
and sandbox tool policies continue to apply; this manifest does not install a
remote transport or automatically grant agents access.
