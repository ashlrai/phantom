# RQ-OSS-MCP-SKILLS-1 — Plugin / MCP / skill ecosystems

**Date:** 2026-11-06 · **Lane:** devin (non-Grok) · **Tier:** work
**Method:** web search + per-project LICENSE file verification (raw.githubusercontent.com
content inspection + npm `license` field). No proprietary source copied; SaaS-only
catalogs marked `skip`. All licenses verified against the linked LICENSE file, not
badge/README claims (anthropics/skills and nodejs/node have multi-part LICENSE
files — read the notes).

## Ranked adoption table

| rank | project | url | license (SPDX) | license_url | tag | effort | impact | Phantom fit note | recommend |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Node `--permission` (built into required Node ≥22.13) | https://nodejs.org/api/permissions.html | MIT | https://github.com/nodejs/node/blob/main/LICENSE | sandbox | S | 5 | Stable since v22.13.0; Phantom already requires ≥22.15.0. Launch plugin-contributed commands and MCP stdio children with `--permission --allow-fs-read=<scope>` to convert the "gating, not containment" posture in `docs/PLUGINS.md` into real OS-enforced least privilege, for free, no new dep. | adopt |
| 2 | Anthropic sandbox-runtime (`srt`) | https://github.com/anthropic-experimental/sandbox-runtime | Apache-2.0 (npm 0.0.81) | https://github.com/anthropic-experimental/sandbox-runtime/blob/main/LICENSE | sandbox | M | 5 | Seatbelt (macOS) + bubblewrap (Linux) sandbox for spawned processes, with a network proxy for domain allowlists. Drop-in wrapper for `verse-mcp-stdio-process` children and future `phm connectors run`; keeps Phantom's deny-by-default policy but enforces it below Node. | adopt |
| 3 | Agent Skills spec + `anthropics/skills` corpus | https://github.com/agentskills/agentskills · https://github.com/anthropics/skills | Apache-2.0 (spec repo); per-skill `LICENSE.txt`, example skills Apache-2.0; `skills/{docx,pdf,pptx,xlsx}` are source-available — do not vendor | https://github.com/agentskills/agentskills/blob/main/LICENSE | skill-format | M | 5 | `SKILL.md` (YAML frontmatter `name`/`description`/`license` + markdown + bundled scripts) is the cross-vendor skill format. Adopt as the interchange format beside Phantom's internal learned-skill cards (`src/core/fleet/skill-library.ts`): import/export SKILL.md, enforce per-skill license check, never ingest the four source-available doc skills. | adopt |
| 4 | MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk | MIT at npm `@modelcontextprotocol/sdk@1.32.2`; repo LICENSE in MIT→Apache-2.0 transition (both permissive) | https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE | mcp-client/sdk | S | 5 | Already a direct dep (`^1.31.0`). Pin the bump and keep the `phm mcp` gateway on the supported line; both license states are vendorable. | adopt |
| 5 | `skills` CLI (vercel-labs) | https://github.com/vercel-labs/skills | MIT (npm `skills@1.7.6`) | https://github.com/vercel-labs/skills/blob/main/LICENSE | skill-format | S | 4 | `npx skills add <repo>` installs SKILL.md packs across 80+ agent runtimes. Fork/vendor the resolver+installer so `phm skills install` can pull audited packs without depending on skills.sh (SaaS index); the per-skill license lint from row 3 rides along. | fork |
| 6 | mcporter (OpenClaw) | https://github.com/openclaw/mcporter | MIT | https://github.com/openclaw/mcporter/blob/main/LICENSE | mcp-client/sdk | M | 4 | TS runtime/CLI to list, call, and codegen typed clients for any MCP server, with an encrypted OAuth vault and record/replay. Ideal substrate for the currently-denied `phm connectors run` surface: typed calls instead of raw argv, secret names never in argv — matches `docs/CONNECTORS.md` custody rules. | adopt |
| 7 | Official MCP Registry | https://github.com/modelcontextprotocol/registry | Apache-2.0+MIT transition | https://github.com/modelcontextprotocol/registry/blob/main/LICENSE | registry | M | 4 | The only non-gatekeeping registry; `phantom-secrets-mcp` is already published there (see `docs/MCP-REGISTRY-PUBLICATION.md`). Add a read path so `phm connectors`/`phm mcp` can resolve server entries (`io.github.*` names) to pinned, hashed packages. | adopt |
| 8 | mcp-proxy (stdio↔HTTP/SSE bridge) | https://github.com/sparfenyuk/mcp-proxy | MIT | https://github.com/sparfenyuk/mcp-proxy/blob/main/LICENSE | mcp-client/sdk | S | 4 | Single-binary transport bridge; lets Phantom run remote `mcp-http` connectors as local supervised stdio children (uniform kill/timeout/audit path in `verse-mcp-stdio`). `geelen/mcp-remote` (MIT, https://github.com/geelen/mcp-remote/blob/main/LICENSE) is the OAuth-bearing alternative — keep as fallback. | adopt |
| 9 | GitHub MCP server (official) | https://github.com/github/github-mcp-server | MIT | https://github.com/github/github-mcp-server/blob/main/LICENSE | mcp-server | S | 4 | Official Go server, read-only toolsets + lockdown mode; maps directly onto the `github` connector profile (`--credential GH_TOKEN=github-access` pattern in `docs/CONNECTORS.md`). Prefer over community GitHub servers. | adopt |
| 10 | playwright-mcp | https://github.com/microsoft/playwright-mcp | Apache-2.0 | https://github.com/microsoft/playwright-mcp/blob/main/LICENSE | mcp-server | S | 4 | Accessibility-tree browser automation for `src/core/verse/browser-mcp.ts`; deterministic snapshots instead of screenshots. `ChromeDevTools/chrome-devtools-mcp` (Apache-2.0, https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/LICENSE) is the CDP-level alternative — adopt one, keep the other as inspire. | adopt |
| 11 | Reference MCP servers (filesystem, postgres, slack) | https://github.com/modelcontextprotocol/servers | MIT (`servers-archived` + older npm releases `server-postgres@0.6.2`, `server-slack@2025.4.25`); current repo in MIT→Apache-2.0 transition | https://github.com/modelcontextprotocol/servers-archived/blob/main/LICENSE | mcp-server | S | 3 | First-party stdio servers for the generic fs/db/slack connector kinds. Reference-quality, not production — run only inside row 1/2 sandboxing with Phantom Secrets-bound env. | adopt |
| 12 | Community SaaS servers: Gmail, Slack, Supabase | https://github.com/GongRzhe/Gmail-MCP-Server · https://github.com/korotovsky/slack-mcp-server · https://github.com/supabase-community/supabase-mcp | MIT, MIT, Apache-2.0 respectively | https://github.com/GongRzhe/Gmail-MCP-Server/blob/main/LICENSE | mcp-server | S | 3 | Fills Gmail/Slack gaps the reference set doesn't cover, and supabase-mcp is the community-blessed Supabase server. All gated behind connector scopes + secrets names; none duplicate paid-connector custody (Phantom keeps Phantom Secrets as the credential root). | adopt |
| 13 | mcpb — MCP bundle packaging | https://github.com/anthropics/mcpb | Apache-2.0+MIT transition | https://github.com/anthropics/mcpb/blob/main/LICENSE | skill-format | M | 3 | `.mcpb` = zipped manifest + server + user-config schema; the emerging portable package for one-click MCP installs. Mirror the manifest for Phantom connector distribution (export a connector profile as an installable bundle) rather than inventing a new pack format. | inspire-only |
| 14 | ToolHive (Stacklok) | https://github.com/stackloklabs/toolhive | Apache-2.0 | https://github.com/stackloklabs/toolhive/blob/main/LICENSE | sandbox | L | 3 | Runs MCP servers in containers with per-server permission profiles, secrets injection, and a registry. Heavier than Phantom needs, but its permission-profile model and curated registry layout are the best documented patterns for MCP server containment. | inspire-only |
| 15 | bubblewrap | https://github.com/containers/bubblewrap | LGPL-2.1 | https://github.com/containers/bubblewrap/blob/main/COPYING | sandbox | S | 3 | Unprivileged Linux namespace sandbox — the mechanism under row 2. Subprocess invocation only (no linking), so LGPL-2.1 is safe for Phantom's MIT tree; do not vendor source. | inspire-only |
| 16 | MCP Context Forge (IBM) | https://github.com/IBM/mcp-context-forge | Apache-2.0 | https://github.com/IBM/mcp-context-forge/blob/main/LICENSE | mcp-client/sdk | M | 2 | Full gateway: federation, virtual-server composition, authN/Z, observability. Too large to adopt; mine its gateway auth and multi-tenancy design for `phm mcp` evolution. | inspire-only |
| 17 | mcpo (Open WebUI) | https://github.com/open-webui/mcpo | MIT | https://github.com/open-webui/mcpo/blob/main/LICENSE | mcp-client/sdk | S | 2 | Exposes MCP tools as OpenAPI/REST. Useful pattern if Phantom ever needs REST-shaped tool access for non-MCP consumers; otherwise unnecessary hop. | inspire-only |
| 18 | Extism (+ Wasmtime) | https://github.com/extism/extism · https://github.com/bytecodealliance/wasmtime | BSD-3-Clause / Apache-2.0 | https://github.com/extism/extism/blob/main/LICENSE | sandbox | L | 2 | WASM plugin isolation — the principled end-state for running third-party skill scripts with a capability host-guest split. Big lift; revisit after rows 1–2 land. | inspire-only |
| 19 | Docker MCP gateway + catalog | https://github.com/docker/mcp-gateway · https://github.com/docker/mcp-registry | MIT / MIT | https://github.com/docker/mcp-gateway/blob/main/LICENSE | registry | M | 2 | Curated catalog schema + containerized gateway with secrets handling. Reference for a future `phm mcp catalog`; catalog is Docker-desktop-oriented. | inspire-only |
| 20 | OpenClaw | https://github.com/openclaw/openclaw | MIT | https://github.com/openclaw/openclaw/blob/main/LICENSE | skill-format | L | 2 | Largest OSS agent runtime with skills+plugins+channels; its tool-policy/tool-profile layering and SKILL.md→tool bridging are worth studying for Phantom's channel/skill policy design. | inspire-only |
| 21 | Continue config packs | https://github.com/continuedev/continue | Apache-2.0 | https://github.com/continuedev/continue/blob/main/LICENSE | skill-format | S | 2 | YAML `config.yaml` packs (models/rules/MCP bundles) — an alternate, simpler pack convention than SKILL.md; borrow ideas for lane-scoped connector presets. | inspire-only |
| 22 | Smithery CLI / registry | https://github.com/smithery-ai/cli | GPL-3.0 (CLI); hosted registry is proprietary SaaS | https://github.com/smithery-ai/cli/blob/main/LICENSE | registry | — | — | GPL-3.0 blocks vendoring into MIT Phantom; the registry gatekeeps installs behind its hosted index. Exactly the "open" registry that isn't — skip. | skip |
| 23 | PulseMCP / Glama / skills.sh | https://www.pulsemcp.com · https://glama.ai · https://skills.sh | Proprietary SaaS catalogs (glama-ai/glama ships no LICENSE) | — | registry | — | — | Discovery-only references; none expose a vendorable OSS index. Do not build runtime resolution against them. | skip |

## Phantom fit notes

- **Containment is the gap.** `docs/PLUGINS.md` is explicit: enabled plugins run in-process with
  Phantom's OS privileges; safety is gating + pinning + audit, not containment. Rows 1–2 are the
  highest-leverage finds — both enforce real isolation for plugin-contributed commands and MCP
  stdio children (`src/core/verse/verse-mcp-stdio-process.ts`) without a new runtime dep (Node) or
  an Apache-2.0 lib already proven by Claude Code (srt).
- **Skill format convergence.** Phantom's learned-skill cards are metadata-only and scrubbed by
  design; SKILL.md is the complement — a human-authored, portable instruction format. Adopting it
  as the interchange layer (import → lint → card) avoids inventing a pack format while keeping the
  existing attestation path. The `license:` frontmatter field gives a machine-checkable gate that
  also refuses Anthropic's four source-available document skills.
- **Connector run surface.** `phm connectors run` is denied pending Security review. mcporter's
  typed-call + vault model and mcp-proxy's transport bridging are the patterns to bring to that
  review; both keep secret *names* in argv and values out, matching the custody rules in
  `docs/CONNECTORS.md`.
- **Registry posture.** Phantom already publishes `phantom-secrets-mcp` to the official OSS
  registry; add the read side (`src/core/mcp-registry.ts` already exists) rather than integrating
  Smithery/PulseMCP/Glama, which are SaaS catalogs with gatekept or unlicensed indexes.
- **Server picks don't duplicate custody.** GitHub/Supabase/Slack/Gmail servers are subprocesses
  bound to Phantom Secrets names — they extend the connector catalog, they never hold credentials
  themselves. No paid-connector source is touched or needed.

## READY one-liners

- **READY:** `permission-wrap` — spawn MCP stdio children + plugin commands under `node --permission --allow-fs-read=<scope>` (no `--allow-child-process`, no net) behind `~/.ashlr` audit; Node ≥22.15 already guarantees it.
- **READY:** `skills import` — SKILL.md importer for `phm skills`: parse `name`/`description`/`license` frontmatter, hard-refuse non-Apache/MIT/Proprietary-declared packs, emit a lint report + learned-skill card.
- **READY:** `connectors run` design doc — propose mcporter-style typed calls + encrypted vault + sandbox-runtime wrap as the Security-review payload to unblock the denied surface.
- **READY:** registry read path — resolve official-registry `io.github.*` server entries to pinned, hashed npm packages inside `phm connectors add` (extends the publish-side pinning already in `docs/MCP-REGISTRY-PUBLICATION.md`).

## Sources

License files verified 2026-11-06 (raw.githubusercontent.com content inspection; npm `license` field where noted):

- https://github.com/nodejs/node/blob/main/LICENSE — MIT (file includes bundled-dep texts; Node itself MIT)
- https://github.com/anthropic-experimental/sandbox-runtime/blob/main/LICENSE — Apache-2.0; npm `@anthropic-ai/sandbox-runtime@0.0.81` Apache-2.0
- https://github.com/agentskills/agentskills/blob/main/LICENSE — Apache-2.0; spec: https://github.com/anthropics/skills/blob/main/spec/agent-skills-spec.md
- https://github.com/anthropics/skills — no root LICENSE; per-skill `LICENSE.txt` (e.g. skills/algorithmic-art/LICENSE.txt = Apache-2.0); README confirms docx/pdf/pptx/xlsx source-available
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE — MIT→Apache-2.0 transition file; npm `@modelcontextprotocol/sdk@1.32.2` MIT
- https://github.com/modelcontextprotocol/python-sdk/blob/main/LICENSE — MIT
- https://github.com/modelcontextprotocol/registry/blob/main/LICENSE — Apache-2.0+MIT transition
- https://github.com/modelcontextprotocol/servers/blob/main/README.md — reference-server scoping + registry pointer
- https://github.com/modelcontextprotocol/servers-archived/blob/main/LICENSE — MIT
- npm: `@modelcontextprotocol/server-postgres@0.6.2` MIT, `@modelcontextprotocol/server-slack@2025.4.25` MIT, `@modelcontextprotocol/server-filesystem@2.2.0` "SEE LICENSE" (transition file)
- https://github.com/vercel-labs/skills/blob/main/LICENSE — MIT; npm `skills@1.7.6` MIT
- https://github.com/openclaw/mcporter/blob/main/LICENSE — MIT
- https://github.com/github/github-mcp-server/blob/main/LICENSE — MIT
- https://github.com/microsoft/playwright-mcp/blob/main/LICENSE — Apache-2.0
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/LICENSE — Apache-2.0
- https://github.com/sparfenyuk/mcp-proxy/blob/main/LICENSE — MIT
- https://github.com/geelen/mcp-remote/blob/main/LICENSE — MIT
- https://github.com/GongRzhe/Gmail-MCP-Server/blob/main/LICENSE — MIT
- https://github.com/korotovsky/slack-mcp-server/blob/main/LICENSE — MIT
- https://github.com/supabase-community/supabase-mcp/blob/main/LICENSE — Apache-2.0
- https://github.com/anthropics/mcpb/blob/main/LICENSE — Apache-2.0+MIT transition
- https://github.com/stackloklabs/toolhive/blob/main/LICENSE — Apache-2.0
- https://github.com/containers/bubblewrap/blob/main/COPYING — LGPL-2.1
- https://github.com/IBM/mcp-context-forge/blob/main/LICENSE — Apache-2.0
- https://github.com/open-webui/mcpo/blob/main/LICENSE — MIT
- https://github.com/extism/extism/blob/main/LICENSE — BSD-3-Clause (Dylibso)
- https://github.com/bytecodealliance/wasmtime/blob/main/LICENSE — Apache-2.0
- https://github.com/docker/mcp-gateway/blob/main/LICENSE + https://github.com/docker/mcp-registry/blob/main/LICENSE — MIT
- https://github.com/openclaw/openclaw/blob/main/LICENSE — MIT
- https://github.com/continuedev/continue/blob/main/LICENSE — Apache-2.0
- https://github.com/jlowin/fastmcp/blob/main/LICENSE — Apache-2.0 (Python FastMCP; distinct from npm `fastmcp` TS pkg, MIT)
- https://github.com/denoland/deno/blob/main/LICENSE.md — MIT
- https://github.com/microsoft/vscode-extension-samples/blob/main/LICENSE — MIT
- https://github.com/tauri-apps/plugins-workspace (v2 branch) — dual `LICENSE_MIT` / `LICENSE_APACHE-2.0`
- https://github.com/smithery-ai/cli/blob/main/LICENSE — GPL-3.0
- https://github.com/anthropics/claude-code/blob/main/LICENSE.md — Anthropic Commercial Terms (proprietary; excluded)
- https://nodejs.org/api/permissions.html — `--permission` stable since v22.13.0/v23.5.0
- https://agentskills.io — Agent Skills standard site
