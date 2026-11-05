# Connector profile

`phm connectors` manages `~/.phantom/connectors/profile.toml`. This is declarative
metadata, the only connector state suitable for plaintext sync. Profile operations never resolve credentials or grant scopes. The run surface
is currently denied pending the separate Security review described below.
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
