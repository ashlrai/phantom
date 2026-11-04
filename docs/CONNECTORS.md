# Connector profile

`phm connectors` manages `~/.phantom/connectors/profile.toml`. This is declarative
metadata, the only connector state suitable for plaintext sync. It never starts
connectors, resolves credentials, grants scopes, or activates a tool or lane.
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
