# Install a tool with Phantom

From a project directory, install a public Node.js tool and its declared MCP
server with one command:

```sh
phm install lexicon
```

Preview or select another existing project directory:

```sh
phm install ashlrai/lexicon --dry-run --json
phm install https://github.com/ashlrai/lexicon --dir /tmp/my-project --json
phm install @ashlr/lexicon --json
```

`lexicon` and `locus` are repository aliases. Other names select npm packages.
URLs must identify public GitHub repositories. Resolution uses anonymous,
bounded HTTPS requests. Private repositories, native installers, compilation,
shell recipes and package lifecycle scripts are outside version 1.

## What gets installed

Phantom resolves an exact npm version or Git commit, stages it beneath the
project's `.phantom/tools/` directory and verifies the declared Node entrypoint.
It registers MCP servers in the project's `.mcp.json` for Claude Code using an
absolute Node executable and script path. It does not change your shell PATH.
These generated paths are machine-specific; keep the install directory and
generated configuration out of shared source unless you deliberately adapt them.

Existing unrelated MCP entries and other settings survive. An existing entry
with the same name must match exactly; conflicting entries are preserved and
reported before installation. Changed configuration is backed up privately.
Repeating an identical install checks its receipt and executable and makes no
changes. A different version or Node path can conflict with the previous entry;
review that entry before replacing it. A matching receipt with missing files is
repaired through a fresh staged install. Unrecognized destinations and altered
receipts are preserved and reported.

`--dry-run` reads metadata and local configuration but creates no files and runs
no installer. Applying uses npm or Git with a private temporary home, no inherited
credentials, no shell, closed stdin and a timeout. npm lifecycle scripts and Git
hooks are disabled. A tool needing build scripts fails with no MCP registration.

Registration proves configuration, not that a server has started. Restart the
client and inspect its MCP status. Claude Code retains its own project-server
approval step, described in its [MCP documentation](https://code.claude.com/docs/en/mcp).

## Manifest version 1

Publish `phantom.install.json` at the repository root. The machine-readable
[JSON Schema](../schema/phantom.install.v1.schema.json) describes the fields.
Use an exact published package version and one of that package's executable names:

```json
{
  "version": 1,
  "id": "example-tool",
  "install": {
    "kind": "npm",
    "package": "@example/tool",
    "version": "1.2.3",
    "bin": "example-mcp"
  },
  "mcp": { "args": [] },
  "secrets": []
}
```

For a Git tool, use `kind: "git"`, `repo: "owner/repo"`, `commit` containing a
full commit SHA, and `bin` containing a relative committed `.js`, `.mjs` or `.cjs`
entrypoint. Repositories with `package.json` must commit `package-lock.json`;
dependencies install with `npm ci --ignore-scripts`. Repository `.npmrc` overrides
are refused. Submodules and build steps are not run. Omit `mcp` for a CLI-only tool.

Resolution checks `phantom.install.json`, then `llms.txt`, then `AGENTS.md`, then
`package.json`, using one pinned repository revision. Documentation may contain
a single fenced `phantom-install` JSON block with the same manifest or a plain
`npm install -g <package>` line. Prose is never executed. Package fallbacks must
identify the requested repository in their npm metadata. A unique executable
ending in `-mcp` supplies an MCP entry with no arguments. Ambiguous binaries need
an explicit manifest. Invalid explicit metadata stops resolution.

## Secrets and results

Credential requirements are names only:

```json
{ "env": "EXAMPLE_API_KEY", "name": "example-service" }
```

Put these objects in `secrets`. Version 1 exposes them through the value-free
`secretHook` result for a future vault adapter. If references are required, status
is `needs-secrets` and nothing is installed or registered. Phantom never asks for
values, copies credentials into config, or treats a vault name as a credential.

`--json` prints one `phantom.install.result.v1` object with `ok`, `status`, resolved
`manifest`, `source`, `evidence`, `directory`, `config`, `registration`, `actions`
and `secretHook`. Status is `planned`, `installed`, `unchanged`, `needs-secrets` or
`failed`. Failures include a safe `error` and omit child-process output.
Exit codes: 0 success, 1 invalid input or failed installation, 2 pending secrets.
Interrupted staging is cleaned up on handled failures. If the process is killed,
confirm no installer is running before removing the project's `.phantom/.install-lock`
directory and abandoned `.install-*` staging directories, then retry.
