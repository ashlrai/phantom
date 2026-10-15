# Inspect Phantom companions

`phm companions` inspects separately installed Phantom Secrets, Locus and Lexicon.

Phantom Secrets, Locus and Lexicon are separate tools with existing workbench
clients. They are not bundled into this workbench package. Inspect installed
executables without reading project configuration or starting a service:

```sh
phm companions
phm companions --json
```

The inventory runs only `--version` and `--help`, using disposable working and
configuration roots with a scrubbed environment. It never invokes a package
manager, reads vault or identity state, registers MCP, accepts project trust,
starts a listener or enables resident authority. Selected executables must be
trusted: a version/help probe executes their code; this is not a sandbox.

| Product | Executable | Reviewed release | Source commit |
| --- | --- | --- | --- |
| Phantom Secrets | `phantom` | [0.7.9](https://github.com/ashlrai/phantom-secrets/releases/tag/v0.7.9) | `7a51ce512ec4aee12cc29ff859036af63fbe93db` |
| Locus | `locus` | [0.5.0](https://github.com/ashlrai/locus/releases/tag/v0.5.0) | `e7bced3cd4cb4adf08bbba020f2e05f163b55941` |
| Lexicon | `lexicon` | [0.5.4](https://github.com/ashlrai/lexicon/releases/tag/v0.5.4) | `6ebc0721e33de2dafafbb54d89a6af50a362046a` |

These pins describe reviewed CLI identity/version surfaces. They do not prove
artifact provenance, runtime contract support or installed readiness. Verify
the selected release artifacts before a separate manual installation. The
workbench command is `phm` (compatible `ashlr`); `phantom` belongs to Secrets.

## Select an installation explicitly

Default discovery examines absolute directories in PATH. Empty/relative PATH
entries are ignored; the current project directory is not searched implicitly.
An explicit absolute PATH entry can select it. Multiple distinct
executables are reported as ambiguous and are not run. Symlinks to the same
physical executable count once. Explicit paths replace discovery for that tool:

```sh
phm companions --secrets-bin /absolute/private/bin/phantom --json
phm companions --bin-dir "/absolute/installation with spaces/bin" --json
phm companions --root /absolute/installation --json
```

`--root` searches only its `bin` directory. Repeated `--bin-dir` and `--root`
options build an explicit search list instead of PATH. `--locus-bin` and
`--lexicon-bin` select the other tools; explicit missing paths remain missing,
with no fallback to another executable. Relative paths are usage errors.
Secrets and Locus probes require a native ELF, Mach-O or PE executable; Node/npm
shims and shell wrappers are refused even with an explicit path. Lexicon's
installed Node CLI entrypoint can be probed. Windows native executables can be discovered, but `.cmd` launchers are not
executed through a shell; select a native executable or review the unsupported
launcher separately. Known legacy npm bootstrap scripts that download/install
on first invocation are also refused; select their already installed native
binary. This recognition is not a proof that arbitrary executable code is safe.
Cross-platform qualification is still required.

## Interpret the report

JSON carries `schemaVersion: 1`, `bundled: false` and `probe: "version-help-only"`.
Each tool reports its path, candidates, product identity, version, reviewed
release and guidance. No raw subprocess output is included.

| Status | Meaning and next step |
| --- | --- |
| `missing` | No executable candidate; review the release's installation guide separately. |
| `ambiguous` | Multiple physical candidates; choose a trusted absolute executable path. |
| `unsupported-launcher` | Secrets/Locus is not native, or the launcher is unsupported/bootstrap code; select an already installed executable. |
| `probe-failed` | Version/help failed, timed out, exceeded bounds or uses an unsupported launcher. |
| `wrong-product` | The version/help identity does not match the expected companion. |
| `unsupported-version` | Product identified, but its version has no reviewed contract in this inventory. |
| `known-interface` | Exact version and help identity match; only the CLI surface is known. |

`installed: true` means the executable identifies the intended product, including
unsupported versions. `compatibility: "known-cli-surface"` means the pinned
identity/version matched. `runtimeCapability` remains `"not-inspected"` for
every result. Neither field establishes Secrets injection, Locus tenant or MCP
session readiness, Lexicon service/project trust, or authority to run agents.
Exit 0 means the inventory completed, including missing/incompatible tools;
exit 2 means invalid arguments. Use the per-tool status for first-run decisions.

See [product names](PHANTOM-BRAND.md) and [first-run guidance](QUICKSTART.md#open-verse).


## Register an already installed MCP server

`phm mcp ecosystem` inspects existing Secrets and Locus MCP executable paths
and their registration entries. Detection does not execute, download or start
those servers. It requires a regular executable with a native binary header,
ignores relative PATH directories and deduplicates symlinks to the same physical
file. Multiple distinct candidates or unsupported/bootstrap launchers are
reported separately and skipped. This header check does not verify an artifact's
signature, its MCP protocol or its account/session readiness.

After selecting one trusted native executable through PATH, use the existing
`phm mcp ecosystem --write` command to register it. New entries keep the selected
absolute physical command path, rather than relying on a later PATH lookup.
Existing complete entries stay configured; incomplete Locus entries use the
existing identity-environment repair. Unreadable, empty or malformed existing settings are refused before
writing, so repair the file first. Valid unrelated keys and server entries are
preserved. Registration alone does not initialize a vault or prove a handshake.

This helper does not register Lexicon. Its project-bound stdio MCP server and the
desktop's separately configured native voice service have different setup and
trust requirements; neither is started by companion inventory.

## Check the tools work together

`phm companions` only reads version and help. To check the seams an agent
actually uses, run the cross-tool smoke from a built Phantom checkout
(`npm run build`) against the companion binaries you want to test:

```bash
node scripts/companion-workflow-smoke.mjs --phm bin/ashlr \
  --secrets-bin /path/to/phantom --secrets-mcp /path/to/phantom-mcp \
  --locus-bin /path/to/locus --locus-mcp /path/to/locus-mcp \
  --lexicon-bin /path/to/lexicon --lexicon-mcp /path/to/lexicon/plugin/mcp-server.mjs \
  --lexicon-hook /path/to/lexicon/plugin/hook.mjs \
  --stack-bin /path/to/stack --stack-mcp /path/to/stack-mcp \
  --mdopen /path/to/mdopen --mdopener-mcp /path/to/mdopener-mcp
```

Every flag is optional; a check whose binary is missing is reported as `skip`.
Each check runs in a disposable home with a scrubbed environment, so no real
vault, pin, lexicon or Stack project is read or changed. It checks:

- `phm companions` identifies each given CLI (a newer release than Phantom's
  reviewed pin is a `warn`).
- Each MCP server completes the stdio handshake for protocol versions
  2025-06-18 and 2025-03-26, keeps stdout protocol-only, and lists the tools
  agents rely on.
- `stack status --json` and `phm stack status --json` both see a project's
  services.
- Lexicon's Claude Code hook exits 0 quickly with JSON or empty output.
- `mdopen` returns promptly and gives a reason when no viewer can open.
- A Locus pin made with `quickstart` and the shell hook reads as healthy
  through Phantom's own Locus parsers, and `ready` is never true while the
  authority anchor is unverified.
- A secret stored with `phantom add --stdin` never reaches a child of
  `phantom exec`, which sees only a `phm_` placeholder and a loopback proxy URL.

Exit 0 means no check failed; exit 1 names the broken seam; `--json` prints
the `phm.companion-workflow-smoke/v1` report.
