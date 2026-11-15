# Growth audit: Phantom and the AshlrAI front door

Observed 2026-11-14 ET (2026-11-15 UTC). Read-only audit of public GitHub pages and README files pinned to the revisions below. No sibling checkout, metadata, pin, issue or PR was changed. The org [public profile](https://github.com/ashlrai) pins Phantom, Phantom Secrets, Locus, Lexicon, AshlrCode and Morphkit. “Not pinned” below means absent from those six public cards.

GitHub REST was rate limited and local `gh` config was inaccessible. Repository metadata comes from GitHub's public page payload; README content was fetched from raw GitHub at each page's exact commit. Last README edit dates were not available from these reads. Freshness below evaluates visible version/capture labels, not inferred activity dates. No star-count or conversion uplift is claimed.

## Phantom change and claim evidence

The README replaces the broad “runs all engineering” claim with an operational description, six feature rows, a short first session and current source UI captures. The static site lives in `site/`; its docs are Markdown copied at deployment by `scripts/generate-docs-llms.mjs`. The separate phm.dev website belongs to the Secrets repository and was not edited.

| README claim | Implementation checked |
| --- | --- |
| Fleet workers, lanes and recorded results | `src/web-ui/routes/verse/sections/FleetSection.tsx`, `src/core/verse/fleet-runs-types.ts` |
| Durable bus and threads | `src/web-ui/routes/verse/fleet-bus/FleetBusPane.tsx`, `src/core/agents/bus-v2-schema.ts` |
| Owner-scoped node jobs, heartbeats and fenced leases | `src/cli/node.ts`, `src/cli/node-fleet.ts`, `src/cli/node-pool.ts` |
| Configured owner thread | `src/core/comms/owner-thread.ts`, `src/cli/comms.ts` |
| Separate Secrets companion via MCP | `.mcp.json`, `src/cli/companions.ts`, `src/cli/mcp.ts` |
| Release evidence and qualification | `src/core/release/status.ts`, `src/core/release/train.ts`, `.github/workflows/ci.yml` |
| Console install and token flow | `src/cli/verse.ts`, `src/web-ui/app/VerseConsoleApp.tsx`, `package.json` |

Screenshots are browser renders of the current source with labeled synthetic data. They establish UI appearance only; no provider execution, native app acceptance, merge or deployment was performed. See [capture provenance](docs/images/CAPTURES.md).

## Sibling gaps and ready-to-apply README patches

Each patch is deliberately small: it changes the entry pitch without rewriting installation, release qualifications or security contracts. Save a diff block to a file and run `git apply --check` in that sibling at the cited revision before applying. These proposals were checked against the fetched README bytes; they have not been pushed. Screenshot capture work remains a proposal, not an invented asset reference.

### phantom-secrets

[README at `9a2f05e9e8d1`](https://github.com/ashlrai/phantom-secrets/blob/9a2f05e9e8d143ba835560184e017ad7822b3ba0/README.md). Public pin: **yes**. Homepage: [https://phm.dev/secrets](https://phm.dev/secrets).

The H1 is “Phantom”, colliding with the workbench brand. The source/release distinction is explicit (0.8.9 candidate versus verified 0.8.7); preserve it. An SVG hero and a demo GIF are present; the GIF has no capture manifest in the README. Lead with the credential-use outcome and label the capture version.

Current About: “Stop AI coding agents from leaking your API keys. Local proxy + MCP that swaps real secrets for phm_ tokens — works with Claude Code, Cursor, Windsurf, and Codex.”

Current topics: `ai`, `ai-safety`, `api-keys`, `api-security`, `claude-code`, `cli`, `codex`, `cursor`, `developer-tools`, `encryption`, `env-files`, `mcp`, `mcp-server`, `phantom`, `proxy`, `rust`, `secrets-management`, `security`, `token-proxy`, `windsurf`.

```diff
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 <div align="center">
 
-# Phantom
+# Phantom Secrets
 
 **Your agent can call the API. The key stays in a local vault.**
 
```

### locus

[README at `42b92d1a4d19`](https://github.com/ashlrai/locus/blob/42b92d1a4d194fe89cdf80baaa3cb56ea0cfa5db/README.md). Public pin: **yes**. Homepage: [https://github.com/ashlrai/locus](https://github.com/ashlrai/locus).

The hero and About use absolute wrong-account prevention language. The README later distinguishes policy modes and enforcement boundaries. Scope the pitch to pinning. Present assets are SVG illustrations, not captured UI; add a dated refusal transcript or dashboard capture. Keep the policy-mode documentation visible.

Current About: “Identity plane for coding agents: wrong account, impossible. Multi-account MCP/CLI bindings so agents never act in the wrong tenant. Works with Phantom: phm.dev”

Current topics: `ai-agents`, `claude`, `claude-code`, `cli`, `codex`, `cursor`, `developer-tools`, `github`, `identity`, `mcp`, `multi-account`, `rust`, `security`, `supabase`, `vercel`.

```diff
--- a/README.md
+++ b/README.md
@@ -2,7 +2,7 @@
 
 <img src="docs/assets/hero.svg" alt="Locus pinned to personal. A command for acme is refused with pin_mismatch." width="720" />
 
-**Your coding agent can't act as the wrong account.**
+**Pin the account your coding agent is allowed to use.**
 
 Locus is the identity plane for coding agents. You pin one client. After that, the CLI, the MCP tools, and the local dashboard act only as that client until a person pins again.
 
```

### ashlr-plugin

[README at `9d4facff8b1f`](https://github.com/ashlrai/ashlr-plugin/blob/9d4facff8b1ff586bb9c0fed15361317d619f645/README.md). Public pin: **no**. Homepage: [https://plugin.ashlr.ai/](https://plugin.ashlr.ai/).

The hero leads with installation mechanics before the benefit. Benchmarks are dated and qualified, but version and tool-count claims need continuing release checks. The three README graphics are SVG illustrations; add a reproducible before/after tool-output capture without claiming whole-session savings.

Current About: “Token-efficiency plugin for Claude Code and Codex: MCP tools and hooks that replace high-volume Read/Grep/Edit/Bash calls with compact equivalents, powered by @ashlr/core-efficiency.”

Current topics: `ai`, `anthropic`, `ashlrcode`, `bun`, `claude`, `claude-code`, `claude-code-plugin`, `codex`, `developer-tools`, `mcp`, `mcp-server`, `plugin`, `token-efficiency`, `typescript`.

```diff
--- a/README.md
+++ b/README.md
@@ -1,6 +1,6 @@
 # ashlr-plugin
 
-> **Install with npm, call the CLI with --json, and register the ashlr-mcp server.**
+**Give coding agents compact tool results and more room for the task.**
 
 ashlr-plugin is an open source efficiency layer for coding agents. It gives Claude Code, Codex, Cursor, and other MCP hosts shorter file, search, edit, and shell results, then records the difference in a local ledger.
 
```

### lexicon

[README at `67bd98632316`](https://github.com/ashlrai/lexicon/blob/67bd98632316d1c52b5175ef5a57761e0c245bb0/README.md). Public pin: **yes**. Homepage: [https://lexicon.ashlr.ai](https://lexicon.ashlr.ai).

Clear problem statement and a 60-second start. The source badge is explicitly labeled 0.5.12; do not turn that into a publication claim. Has SVG hero/flow and demo, CLI-setup and fix-in-place GIFs. Add source/version provenance to captures and bring one useful before/after example nearer the pitch.

Current About: “A personal lexicon for voice-to-agents. One YAML file of the words speech-to-text gets wrong, applied everywhere your voice lands: MCP, Claude Code, the browser, macOS.”

Current topics: `accessibility`, `ai-agents`, `browser-extension`, `claude`, `claude-code`, `cli`, `dictation`, `macos`, `mcp`, `model-context-protocol`, `speech-to-text`, `swift`, `typescript`, `vocabulary`, `voice`, `whisper`.

```diff
--- a/README.md
+++ b/README.md
@@ -6,7 +6,7 @@
 
 **Speech-to-text gets English right and your names wrong.**
 
-Lexicon is one YAML file of the words you actually say. It rewrites the transcript before an agent reads it. It is not a dictation app.
+Lexicon corrects recurring speech-to-text errors before an agent reads the transcript, using your own YAML vocabulary. It works alongside your dictation app.
 
 [![CI](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml/badge.svg)](https://github.com/ashlrai/lexicon/actions/workflows/ci.yml)
 [![npm](https://img.shields.io/npm/v/%40ashlr%2Flexicon)](https://www.npmjs.com/package/@ashlr/lexicon)
```

### ashlr-md

[README at `b8ee45c2b7e1`](https://github.com/ashlrai/ashlr-md/blob/b8ee45c2b7e14d86535b6f506cf5b4ae72566d26/README.md). Public pin: **no**. Homepage: [https://md.ashlr.ai](https://md.ashlr.ai).

The tagline says agents can drive the app, but omits the reader/editor benefit. Release 0.4.0 is named; verify matching platform assets before updating it. Three PNG product illustrations are present; label whether they are native captures, mockups or annotated composites. Avoid “free on-device AI” in About without hardware/model qualifications.

Current About: “An open-source, AI-native Markdown app for macOS, Windows, and Linux. Open any .md and it's instantly beautiful, with free on-device AI and agent (MCP) integration.”

Current topics: `agents`, `ai`, `claude`, `cross-platform`, `linux`, `macos`, `markdown`, `markdown-editor`, `markdown-viewer`, `mcp`, `on-device-ai`, `react`, `rust`, `tauri`, `windows`.

```diff
--- a/README.md
+++ b/README.md
@@ -4,7 +4,7 @@
 
 # Ashlr MD
 
-**The Markdown app agents can drive.**
+**Read and edit Markdown with a desktop app your agents can drive.**
 
 Ashlr MD opens `.md` files on macOS, Windows, and Linux, and it speaks [MCP](https://modelcontextprotocol.io/). An agent can install the CLI, open a document, edit it, export it, and wait for a person to approve it.
 
```

### ashlr-stack

[README at `933bead02d93`](https://github.com/ashlrai/ashlr-stack/blob/933bead02d9371a9d7cd3f32c87114312e11a4be/README.md). Public pin: **no**. Homepage: [https://stack.ashlr.ai](https://stack.ashlr.ai).

Useful no-account read-only quickstart and explicit provider limitations. Source 0.3.10 and published 0.3.6 are distinguished. Three SVG illustrations are present, with no README product screenshot. The first paragraph is long; retain credential caveats after the concise pitch. Prefer developer-tools over the existing dev-tools topic.

Current About: “Provision and connect development services through CLI and MCP tools, with Phantom for credential handling.”

Current topics: `anthropic`, `ashlr`, `astro`, `bun`, `claude-code`, `cli`, `cursor`, `dev-tools`, `devops`, `infrastructure`, `mcp`, `model-context-protocol`, `openai`, `phantom-secrets`, `stack`, `supabase`, `typescript`, `vercel`, `windsurf`.

```diff
--- a/README.md
+++ b/README.md
@@ -9,7 +9,7 @@
 [![source v0.3.10](https://img.shields.io/badge/source-v0.3.10-blue.svg)](CHANGELOG.md)
 <!-- fresh:end -->
 
-**Configure supported services from your terminal or your AI agent.** Stack uses provider-specific OAuth or supplied credentials, provisions where the adapter supports it, and records selected credentials in [Phantom Secrets](https://phm.dev/secrets), Stack configuration and provider MCP entries. Vercel requires an existing personal access token; Stack does not create that token. Export an empty `.env.example` separately with `stack env export --example`.
+**Set up your development stack from the terminal or an AI agent.** Stack uses provider-specific OAuth or supplied credentials, provisions where the adapter supports it, and records selected credentials in [Phantom Secrets](https://phm.dev/secrets), Stack configuration and provider MCP entries. Vercel requires an existing personal access token; Stack does not create that token. Export an empty `.env.example` separately with `stack env export --example`.
 
 New projects stall on account setup, copied keys, and agent config. Stack turns the supported part of that work into commands an agent can run and parse.
 
```

## Metadata recommendations (separate SEC-gated change)

Do not run `gh repo edit` as part of this change. Preserve existing homepages below; they are current GitHub metadata, not a claim of deployment health. Replace the About text with the proposed wording only after the separate review.

| Repo | Proposed description | Homepage | Topic proposal | Pin proposal |
| --- | --- | --- | --- | --- |
| phantom | Open-source workbench for coding agents: coordinate fleets, inspect agent messages and review work across computers. | https://phm.dev | `agent-orchestration`, `ai-agents`, `coding-agents`, `multi-agent`, `mcp`, `local-first`, `local-models`, `developer-tools`, `cli`, `typescript` | Keep |
| phantom-secrets | Local vault, placeholders and proxy for supported API calls without putting raw credentials in agent context. | https://phm.dev/secrets | Keep current security/proxy topics; use the full Secrets name in copy | Keep |
| locus | Account and tenant bindings for coding-agent CLI and MCP tools, with explicit pinning and policy modes. | https://github.com/ashlrai/locus | Keep current identity/multi-account topics | Keep |
| ashlr-plugin | Compact read, search, edit and shell results for coding agents, with MCP tools and a local usage ledger. | https://plugin.ashlr.ai/ | Keep `token-efficiency`, `mcp`, `claude-code`, `codex`, `developer-tools`; drop generic `plugin` if reducing noise | Candidate for a future six-slot pin rotation; no automatic replacement |
| lexicon | Correct recurring speech-to-text errors before agents read them, with a personal YAML vocabulary. | https://lexicon.ashlr.ai | Keep `speech-to-text`, `vocabulary`, `voice`, `accessibility`, `mcp` and platform topics | Keep |
| ashlr-md | Desktop Markdown reader and editor with CLI and MCP interfaces for agent workflows. | https://md.ashlr.ai | Keep Markdown/platform topics; prefer `ai-agents` over `agents` | Leave unpinned for now |
| ashlr-stack | Configure supported development services through CLI and MCP, with provider-specific credential handling. | https://stack.ashlr.ai | Replace `dev-tools` with `developer-tools`; retain `infrastructure`, `devops`, `mcp` and supported-provider topics | Leave unpinned for now |

## Follow-up priorities

1. Capture native Phantom.app on a qualified build using a dedicated demo profile. Browser images cannot establish native window or updater behavior.
2. Add capture manifests (revision, viewport, data provenance and regeneration steps) to sibling image sets. Keep diagrams labeled as diagrams.
3. Standardize ecosystem cross-links around **Phantom** (workbench) and **Phantom Secrets** (vault/proxy). Preserve distinct `phm` and `phantom` commands.
4. Review static version/tool-count claims at release time; do not refresh dates or badges without source evidence. Measure README click-through and stars after publication before asserting a growth effect.
