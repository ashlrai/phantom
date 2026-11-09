# Agent roster

`phm agents roster` and `phm agents roster --json` read one live session roster.
The same payload is the MCP tool `phm_agent_roster` and `GET /api/verse/fleet/agent-roster`, which the Observe pane shows as All agents.

Each probe runs in parallel and gives up after about 5 seconds. A timeout, a missing command, or an output shape the official docs do not specify becomes `availability: "unknown"` with a reason. Empty `sessions` on an unknown source means the probe does not know, not that nothing is running. Known sources with zero sessions were observed and were idle.

Sources:

| Source | Surface | When it is known |
| --- | --- | --- |
| `phantom` | The live process table of jobs Phantom dispatched (`listLiveWorkers`) | The process table was readable |
| `devin-cloud` | Devin REST `listSessions` through `src/core/devin/client.ts` | A connected org key returns a session page. This is web and cloud sessions, not Devin Desktop |
| `devin-desktop` | `devin list --help` | Stays unknown. Official docs describe `devin list` as current-directory CLI sessions (`--format json` has no documented field list) and `devin desktop` as opening the app. Desktop orchestration sessions are not in the cloud sessions API |
| `codex` | `codex agents --help` | Stays unknown. `codex agents` is an interactive command center with no documented machine-readable session list |
| `claude` | `claude agents --json` after `--help` advertises `--json` | The JSON array matches the documented fields (`pid`, `kind`, `startedAt`, and `sessionId`, `name`, `status` when set) |
| `cursor` | `cursor-agent ls --help`, or `agent --help` when that help names Cursor | Stays unknown. `ls` opens an interactive chat picker |
| `grok` | `grok sessions list --help` | Stays unknown. The command prints a human table for the current directory and does not document a machine-readable schema |
| `ollama` | `GET http://127.0.0.1:11434/api/ps` | The loopback status returns a `models` array. Those rows are loaded models |
| `omlx` | `GET http://127.0.0.1:8123/v1/models` | The loopback status returns a `data` array. Those rows are listed models (`state: "listed"`), not proof of a live generation |

Claims come from the coordination claim store, or from the read-only bus work claim table when the store is missing or unavailable; the roster labels the source used. A claim is attached to a session only when the claim id equals the session id. The fencing token is not copied. Team leases are a separate store and are not merged into this view.

The probes do not read app databases, session stores, or credential files, and they do not print secrets. Local HTTP calls stay on `127.0.0.1` and do not follow redirects.

Copy-paste:

```sh
phm agents roster --json
phm agents roster
```
