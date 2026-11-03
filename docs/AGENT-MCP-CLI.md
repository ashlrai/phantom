# Use Phantom from an agent

Copy the blocks in order. Do not invent flags. If `phm docs --agent --json` disagrees with this page, trust the installed binary. A zero exit code is not a merge, a release, or permission to spend.

`phm` and `ashlr` are the same program. Examples use `phm`.

## 1. Install

Node.js 22.15.0 or newer.

```sh
node --version
npm install -g @ashlr/phantom
phm --version
```

This source tree is not proof that npm has published the same version. Check [GitHub releases](https://github.com/ashlrai/phantom/releases/latest) before you pin one.

## 2. Read the command list

```sh
phm docs --agent --json
phm help
```

Use the JSON registry for commands, verbs, and flags. This page only shows the calls an agent needs on a cold start.

## 3. Commands that print JSON

These read local state. They do not start a fleet and they do not spend credits.

```sh
phm mcp list --json
phm mcp doctor --json
phm wire status --json
phm authority status --json
phm authority setup --dry-run --json
```

`phm mcp doctor` exits 1 when a required server is down. That is a health result. `phm authority status --json` reports the grant. Autonomy ships dormant and is macOS-only. Status does not turn it on. `phm authority setup --dry-run --json` prints the setup plan and does not sign a grant.

## 4. Open the console

```sh
phm verse --no-open --json
```

The server listens only on [http://127.0.0.1:7777/verse/](http://127.0.0.1:7777/verse/). The JSON includes a read token and a mutation token. Do not put either token in a PR, issue, or chat log.

## 5. MCP for Claude Code

Claude Code reads `mcpServers` in `~/.claude.json`. This backs up the file, then writes the gateway:

```sh
phm wire claude --json
```

Or paste this entry yourself:

```json
{
  "mcpServers": {
    "ashlr-hub": {
      "type": "stdio",
      "command": "ashlr",
      "args": ["mcp"],
      "env": {}
    }
  }
}
```

The server key is `ashlr-hub`. Do not reuse the `ashlr` key. That name belongs to a different plugin.

## 6. MCP for Cursor

Cursor reads `mcpServers` in `~/.cursor/mcp.json`.

```sh
phm wire cursor --json
```

Or paste:

```json
{
  "mcpServers": {
    "ashlr-hub": {
      "command": "ashlr",
      "args": ["mcp"]
    }
  }
}
```

## 7. MCP for Codex

Codex stores servers in `~/.codex/config.toml`. Do not hand-edit that file. `codex` must be on `PATH`.

```sh
phm wire codex --json
```

That command runs `codex mcp add ashlr-hub -- ashlr mcp` after a backup.

## 8. Check that the gateway is actually up

Restart the editor so it reloads MCP servers. Then:

```sh
phm wire status --json
phm mcp doctor --json
```

A row that says the file contains `ashlr-hub` only proves the config write. `phm mcp doctor` is the start check. Registration is not authorization.

## 9. Read-only fleet server

This is a second MCP server. It does not launch work and it does not merge. Add it beside `ashlr-hub`, not instead of it.

```json
{
  "mcpServers": {
    "phantom-fleet": {
      "command": "phm",
      "args": ["mcp", "fleet"]
    }
  }
}
```

After MCP initialization, call `tools/list`, then `fleet_status` with `{}`. Argument rules and the other tools are in [the fleet MCP onramp](FLEET-MCP-ONRAMP.md).

## 10. Optional cloud handoff

Off unless you run these. They do not merge by themselves.

```sh
phm cloud launch "<task>" --repo owner/name
phm devin connect
phm devin launch "<task>"
```

See [Cloud](CLOUD.md) and [Devin](DEVIN.md).

## Indexes

- [llms.txt](llms.txt): short doc index
- [llms-full.txt](llms-full.txt): the same install and MCP blocks in one text file
- [Self-hosting](SELF-HOSTING.md): upgrade and uninstall
- [Quickstart](QUICKSTART.md): first local session for a person

## Gateway tool policies

Set `ASHLR_MCP_POLICY` to a host-owned YAML file before starting `phm mcp`.
Set `ASHLR_MCP_AGENT` and comma-separated `ASHLR_MCP_GROUPS` in the trusted
launcher, never from tool arguments. Restart the gateway after changing policy.

```yaml
ask_before_every_change: false
read_tools: [locus__status]
policies:
  - name: developer-tools
    agents: [codex]
    groups: [engineering]
    tools:
      locus__status: allow
      locus__delete: deny
      locus__update: approval_required
```

Tool keys are exact `<server>__<tool>` names. Empty agent and group lists match
all callers; otherwise either selector can match. Matching verdicts resolve as
`allow > approval_required > deny`. Unmatched calls and an unset policy file
retain existing behavior. Invalid or unreadable configured files fail startup.
The fleet switch overrides an allow for every tool absent from `read_tools`:
unclassified tools conservatively count as writes. Keep this file and launcher
identity under administrator control. Denied and approval-required calls return
an MCP tool error naming the policy before downstream activation or execution.
Approval-required calls remain blocked; request arguments cannot approve them.
Native hub tools retain their existing authorization path.
