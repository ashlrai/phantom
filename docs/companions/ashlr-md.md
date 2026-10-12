# Ashlr MD — Phantom's Markdown opener

[Ashlr MD](https://github.com/ashlrai/ashlr-md) ([md.ashlr.ai](https://md.ashlr.ai)) is the
open-source, AI-native Markdown app in the Phantom ecosystem. Phantom uses it out of the box
to open Markdown files.

## Behaviour

When Phantom opens a `.md` / `.markdown` / `.mdx` file — `phantom open <query>` in the CLI,
or **Open** in the web/desktop UI (`POST /api/open`) — it:

1. Uses **Ashlr MD** via `mdopener://open?path=<abs path>` if it is installed
   (detected via the `mdopen` CLI on `PATH`, or the app in `/Applications` /
   `~/Applications` on macOS, `%LOCALAPPDATA%\Programs\Ashlr MD` on Windows,
   `/usr/bin/ashlr-md` or the `.desktop` entry on Linux).
2. Otherwise falls back to your configured editor (`cursor` / `vscode`) — nothing breaks —
   and the CLI prints a one-line install offer.

Non-Markdown files are unaffected. Wiki citations that jump to a specific line still use
your editor (Ashlr MD has no line addressing).

## Install

Download the build for your OS from the
[latest release](https://github.com/ashlrai/ashlr-md/releases/latest)
(macOS `.dmg`, Windows `.msi`/`.exe`, Linux `.deb`/`.rpm`/`.AppImage`), or build from source
with `bash scripts/install.sh` in the ashlr-md repo, which also installs the `mdopen` CLI and
wires the Ashlr MD MCP server into Claude Code. A Homebrew cask is planned
(`packaging/homebrew/ashlr-md.rb` in ashlr-md) but not yet published.

## Configuration

In your Phantom config (`phantom config` shows the path):

```json
{ "markdownOpener": "editor" }
```

| Value | Effect |
|---|---|
| `"ashlr-md"` (default) | Ashlr MD when installed, editor otherwise |
| `"editor"` | Always use the configured editor (opt out) |

`PHANTOM_ASHLR_MD=0` forces the fallback and `PHANTOM_ASHLR_MD=1` skips detection
(useful in CI or unusual install locations).

## Agents

Ashlr MD ships an MCP server (`mdopener-mcp`) whose `open_file` tool lets agents show a
document to a human for review — see Ashlr MD's
[docs/AGENTS.md](https://github.com/ashlrai/ashlr-md/blob/main/docs/AGENTS.md) and
[docs/PHANTOM.md](https://github.com/ashlrai/ashlr-md/blob/main/docs/PHANTOM.md).
