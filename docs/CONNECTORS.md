# Connector profile

`phm connectors` manages `~/.phantom/connectors/profile.toml`. This is declarative
metadata, the only connector state suitable for plaintext sync. Profile operations never resolve credentials or grant scopes. Connectors start
through [`phm connectors exec`](#launch-with-credentials); the older `run` surface
stays denied pending the separate Security review described below.
Empty tools/lanes select no consumers; selectors are explicit names, not wildcards.

```sh
phm connectors add context7 --kind mcp-http --url https://mcp.context7.com/mcp --scope docs --tool claude --lane work --json
phm connectors add github --kind cli --command gh --scope repo-read --tool claude --lane work --credential GH_TOKEN=github-access --json
phm connectors list --json
phm connectors show github --json
phm connectors remove github --json
phm connectors import --json
```

`--arg`, `--scope`, `--tool`, `--lane`, and `--credential` may repeat.
Credential bindings point to Phantom Secrets **names**, never values. Do not put
credentials into argv, command strings, URLs, examples, logs, or this file.
HTTP endpoints require HTTPS, except loopback HTTP. URLs cannot contain userinfo,
queries or fragments. No OAuth listener is started.

```toml
version = 1

[[connectors]]
id = "github"
kind = "cli"
command = "gh"
args = []
scopes = ["repo-read"]
tools = ["claude"]
lanes = ["work"]
credentials = [{ binding = "GH_TOKEN", name = "github-access" }]
```

Both reads and writes validate all metadata, refuse unknown fields and secret
shapes, and return errors without rejected values. Writes use an exclusive lock
and atomic replacement. A duplicate add never overwrites an entry. If a writer
was interrupted, ensure it has stopped before removing
`~/.phantom/connectors/.profile-lock` and retrying.

## Import existing clients

Import examines the `mcpServers` maps in `~/.claude.json` and
`~/.cursor/mcp.json`, including any configured Context7, GitHub, Sentry, PostHog,
Supabase, Vercel, Gmail and Drive entries. Names and credential-free URLs or
executable paths are projected; arbitrary config fields and arguments are never
copied. Existing profile ids are preserved. Reports contain validated imported
ids and static source labels/reasons, never client payloads or parse errors.

Codex import requires an explicit `CODEX_HOME` pointing to an existing lane
under `~/.ashlr-runs`, with a regular `config.toml` containing `mcp_servers`.
Missing or unsafe lane paths are skipped and reported. `~/.codex` is never
opened or written. Config symlinks are refused. The importer does not scan other
Codex homes or modify any client configuration.

Credential-bearing entries (env or HTTP headers included) are withheld, not
silently imported without authentication. The installed Phantom Secrets CLI
requires a trusted-terminal ceremony for `phantom import`; it has no client
config migration adapter. **Automatic inline credential migration is therefore
not supported in this version.** In a trusted terminal, consult
`phantom import --help` and use its own import command; do not export values into
another config or hand them to an agent. Then remove inline credentials from
the client through its supported secret-reference mechanism and add only the
connector metadata and vault names with `phm connectors add`. Entries with
arguments require explicit review and `add --arg` to avoid copying credential
arguments. This importer never claims that skipped entries were migrated.

Every verb supports `--json`, including errors (`{ok:false,error}`). Exit codes:
0 success/help, 1 partial import (inspect `skipped`), 2 invalid usage/profile or
I/O failure. List returns `{version:1,connectors:[...]}`, show `{connector}`,
add `{ok:true,connector}`, remove `{ok:true,removed}`, and import
`{imported:[id],skipped:[{source,reason}]}`. Plain output is readable JSON;
`phm connectors --help` prints usage.


## Launch with credentials

```sh
phm connectors add github --kind cli --command gh --tool claude --lane work --credential GH_TOKEN=GITHUB_ACCESS --json
phm connectors exec github --tool claude --lane work -- gh repo list --json name
phm connectors config --client claude --lane work --json
```

`exec` starts a `cli` or `mcp-stdio` connector. The tool and lane must both be
listed on the connector (empty lists deny), and the first word after `--` must
be the profile `command` exactly; profile `args` follow it, then your extra
arguments. Extra arguments pass the same credential-argument and secret-shape
refusal as the profile.

Phantom never holds a credential value. A connector without credentials starts
directly, with Phantom-internal variables removed. A connector with credentials
starts as `phantom --quiet exec -- phm connectors exec-session <id> ...`:
Phantom Secrets resolves vault entries for the project in the working directory
(or `--project <dir>`, which must hold `.phantom.toml`) and keeps real values in
its loopback proxy. Its child receives only session tokens. The `exec-session`
step re-reads the profile, sets each binding to the session token issued for its
vault name, removes every other session token, and starts the command. A vault
name Phantom did not serve stops the launch. `exec-session` refuses to run
outside `phantom exec`, and it only remaps tokens already in its environment.

Credential `name` values used with exec must be the keys Phantom Secrets protects
in that project (`phantom list`), for example `GITHUB_ACCESS`. Bindings may differ.
Check a key with `phantom why <KEY>`; a key without a proxy route reaches the
child as a token no provider accepts.

What this guarantees: argv at every level (visible in `ps`) contains ids,
selectors and executables only; nothing is written to disk or logged by Phantom;
real values stay inside the `phantom exec` process. Session tokens in the child
environment end with the session. On success `exec` writes nothing to stdout, so
an MCP stdio server's protocol stream is untouched. The exit status is the
child's (128 + signal number when it was killed); a refusal exits 2 with
`{ok:false,error}` under `--json`. `phantom` must be installed for connectors
with credentials.

### Client configs

`phm connectors config --client claude|cursor|codex --lane <lane> [--project <dir>] [--json]`
prints MCP entries for every `mcp-stdio` and `mcp-http` connector that lists the
client as a tool and the lane. Stdio servers launch through the wrapper, so the
entry holds no token, env or header:

```json
{
  "mcpServers": {
    "github": {
      "command": "phm",
      "args": ["connectors", "exec", "github", "--tool", "claude", "--lane", "work", "--", "github-mcp-server"]
    }
  }
}
```

Codex output is TOML under `mcp_servers`. Credential-free HTTP endpoints are
emitted as `url` entries. HTTP connectors with credentials are skipped and
reported (exit 1): header injection is not provided in this version. Every
snippet is checked against the secret-shape gate before it is printed. The
command writes nothing; paste the snippet into the client yourself. For Codex,
use a lane `CODEX_HOME` under `~/.ashlr-runs`, never `~/.codex`. JSON output is
`{client, lane, format, servers, skipped, config}`; plain output is the snippet,
with skipped entries on stderr.

## Run a CLI connector

```sh
phm connectors run github --scope repo-read --tool codex --lane work --json -- repo list --json name
```

Place Phantom's `--json` before `--`; everything after it belongs to the CLI,
including its own JSON flags. Run returns `{ok:false,error}` and exit 2 while
Security review is pending. It starts no process, including for entries with no
credentials. Matching selectors are necessary but are not Locus authorization.
Empty selectors deny access. MCP and plugin kinds cannot run through this verb.

The separate `codex-bridge/RQ-COS-CONNRUN-1-sec` change must authorize the exact
scope, tool and lane through Locus and inject Phantom Secrets bindings directly
into the child environment without exposing values to argv, files, logs or
returned output. No feature flag or environment variable enables this stub.
Third-party sends must remain draft-then-approve, with a needs-you item and
explicit approval before sending. Arbitrary CLI execution must not bypass that
rule. This worktree contains no credential injection implementation.

Seed CLI entries below use binding names only. They are not executable until
the Security change lands. Choose JSON output in the child invocation, for
example `gh repo list --json name`, `vercel list --format json`, or
`supabase projects list --output json`. Install official CLIs separately.

```toml
[[connectors]]
id = "vercel"
kind = "cli"
command = "vercel"
scopes = ["projects-read"]
tools = ["codex"]
lanes = ["work"]
credentials = [{ binding = "VERCEL_TOKEN", name = "vercel-access" }]

[[connectors]]
id = "supabase"
kind = "cli"
command = "supabase"
scopes = ["projects-read"]
tools = ["codex"]
lanes = ["work"]
credentials = [{ binding = "SUPABASE_ACCESS_TOKEN", name = "supabase-access" }]
```

Use the GitHub entry above with `tools = ["codex"]` for the run example. These
blocks append to the version 1 profile. CLI authentication support must be
verified during Security review; no token argument adapter is provided here.

Reserve Gmail, Calendar, Drive, Brex, X and Stacksync as MCP entries for a later
line, only for capabilities without an official CLI. Their endpoints and
credentials are intentionally unconfigured; do not invent executable profiles.


| Deferred entry id | Kind | Capability |
| --- | --- | --- |
| gmail | mcp-http | Gmail |
| calendar | mcp-http | Calendar |
| drive | mcp-http | Drive |
| brex | mcp-http | Brex |
| x | mcp-http | X |
| stacksync | mcp-http | Stacksync |

These are planning entries, not importable TOML. Endpoint selection and the
absence of a suitable official CLI require verification in the later line.
Official JSON-output references: [GitHub](https://cli.github.com/manual/gh_repo_list),
[Vercel](https://github.com/vercel/vercel/blob/main/skills/vercel-cli/references/monitoring-and-debugging.md),
and [Supabase](https://supabase.com/docs/reference/cli/global-flags).

## Tool mesh

`phm connectors mesh --json` combines the gateway's native tool descriptions,
input schemas and safety classes with connector profile metadata. Connector
descriptions are optional user-supplied metadata (`--description` on add);
`tools` are agent selectors, not a remotely discovered tool list. Scope, agent and lane selectors and credential binding names describe
requirements, not grants. The output omits executable arguments, endpoints and
vault names. Executable availability checks PATH presence only; an HTTP endpoint
and the gateway remain unknown until separately tested. No connector is started.

The existing `phm wire claude|cursor|codex --json` commands register the gateway
with clients. Use `phm connectors import --json` to import supported client
metadata; profile entries are not automatically installed in a client or gateway.
Native tools are invoked through the gateway and retain its authorization checks.
CLI connectors start with `phm connectors exec`; MCP entries need a client
(`phm connectors config` prints one) and plugin entries need their host. This registry does not create permissions.

### Lane view and shared tool registry

`phm connectors mesh --lane <lane> --json` omits connectors restricted to other
lanes (an empty lane list is unrestricted for discovery only; running a
connector still needs an explicitly listed lane). It adds `capabilities`: MCP
and CLI connector ids, web search (client-provided or a registered MCP
connector; the hub does not proxy it) and the gateway's computer-use hooks,
each of which keeps its own confirmation checks.

Agents can extend the mesh with `phm connectors tool create --spec '<json>'`.
Entries are declarative data stored in `~/.phantom/connectors/registry.json`
(mode 0600), never code. A `skill` renders a parameter template and returns it
flagged `untrusted` (agent-authored text is not an owner instruction). A
`connector-call` needs an existing `cli` connector and routes through
`phm connectors run`, so it stays denied pending Security review. Entries are
schema-validated, secret-shaped text is refused at create and invoke, ids may
not collide with native gateway tools, and placeholders must be declared.
`createdBy` is a caller-declared label, not an authenticated identity.
`phm connectors tool list|show|invoke|revoke|remove` manage them; a revoked
entry is neither discoverable nor invocable. The registry grants no permissions.
