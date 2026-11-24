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
phm agents roster --principal local --json
phm agents roster --all-owners --json
```

## Owner projections (M2 stub)

Rows carry `principal` and `kind: local|external`. The existing claim field
`owner` still means a lane label. `local` denotes the local owner before
enrollment; it is not an authenticated owner id. Teammate agents from the
existing mesh appear as external, with an unverified principal when their
hosting owner is unknown. This adds no second roster store.

`--all-owners` and an opaque `--principal own_<32 hex>` selector return only
`qualifiedHandle`, `kind`, `status` and `lastSeen`. The handle is the structured
`{handle, owner}` pair, or null when either identity is unverified. Last-seen is
bucketed to 15 minutes. Provider session ids, titles, URLs, organizations,
account and device references, machine names, load, memory and usage never
enter this projection. `--principal local` keeps the detailed local view.

The MCP roster selectors use `principal` or `allOwners` with the same
projection. These are local views of existing data, not cross-owner access:
`checkGrant()` denies every input in M2, including well-shaped grants. There
is no flag, environment variable or configuration switch to enable it.

## Portable bundles

```sh
phm bundle export agent reviewer --out reviewer.bundle.json
phm bundle export agent reviewer --out reviewer-memory.bundle.json --include-memory
phm bundle export tool lint-helper --out lint-helper.bundle.json
phm bundle inspect reviewer.bundle.json --json
phm bundle import reviewer.bundle.json --as reviewer-copy --json
phm bundle import reviewer.bundle.json --as reviewer-copy --apply --json
```

`phantom.bundle.v1` carries profile metadata, doctrine and prompts, connector
references and automation definitions. The memory seed is included only with
`--include-memory`. Each part has a SHA-256 content digest; the bundle uses
canonical JSON (RFC 8785). Inspect and import require that canonical encoding,
so duplicate keys and ambiguous encodings are refused.
Provider authentication, sessions, keychains, environment files and token
files are refused before export reads them. Secret-shaped content is refused
using the existing shared scrubber.

Import is a dry run unless `--apply` is present. All writes stay within the
new agent's own profile directory. Absolute paths, traversal, symlink escapes
and pinned targets are refused. Existing profile ids are never overwritten.
The imported agent is drafts-only. Connectors and automations remain disabled
data; importing does not register or execute them. Secret names remain unbound,
even if a matching local name already exists. Command connectors need explicit
owner enablement outside an agent. M2 supplies no enable command.

Private, loopback and link-local literal HTTPS addresses and localhost names
are refused. Other hostnames are accepted as disabled data only: M2 performs
no DNS lookup and does not establish that a hostname resolves publicly.

The [multi-owner design](design/multi-owner-fleet.md) remains pending Security
review. M2 implements no signing, key storage, transport or cross-owner sends.

## Teammate origin boundary

The existing teammate enqueue entry accepts bus envelopes as data. A host
intake must supply local provenance separately from the envelope before a
task addressed to a teammate can become a preview or queue reservation.
Sender labels and body fields cannot supply that provenance. Foreign or
unknown origins are retained as inert context in the existing bus, without
preview, enqueue or claim. M2 supplies no remote authentication or automatic
dispatch; the existing transport gates remain in force.
