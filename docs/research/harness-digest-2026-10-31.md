# Harness digest — 2026-10-31

What the leading agent harnesses shipped in late October 2026, checked on
2026-10-31 UTC against public changelogs and repositories. Each source's
license was read before its design is described; takeaways are restated in
our own words and no code was copied. Every Phantom path named in a takeaway
exists on origin/master and names the file a follow-up job would change.

## S1 — Anthropic Claude Code changelog
- Checked: 2026-10-31.
- Source: [Claude Code changelog](https://code.claude.com/docs/en/changelog)
- Source: [anthropics/claude-code releases](https://github.com/anthropics/claude-code/releases)
- License: Proprietary Anthropic product; public changelog and docs, no source license. Ideas only.

October releases ran v2.1.287 through v2.1.316: Claude Mods plugin depth,
Haiku 5.5 as the default Haiku, idle compaction, and a run of permission and
sandbox hardening. The product is closed; the changelog is the source.

- Takeaway: v2.1.314 adds permissions.blockWritesOutsideWorkingDirectories so Write, Edit and NotebookEdit refuse paths outside the working directories in every permission mode. Phantom file `src/core/sandbox/policy.ts`; job: audit every file-write and edit path so refusal holds in all permission modes, not only the default gate.
- Takeaway: v2.1.316 adds CLAUDE_CODE_SUBAGENT_EFFORT so subagents run at their own default effort instead of inheriting the session's. Phantom file `src/core/learn/harness-types.ts`; job: add a subagent-role effort default to the harness config envelope.
- Takeaway: October builds idle-compact a 200K+ token conversation after roughly 54 idle minutes, with a config opt-out. Phantom file `src/core/run/context-window.ts`; job: spec an idle-time trigger that compacts long-lived runs before the window forces mid-tool truncation.
- Takeaway: v2.1.316 adds pooled group budgets — one monthly budget a group's members share on top of each member's own limit. Phantom file `src/core/run/budget.ts`; job: spec a shared lane pool cap layered over per-run budgets instead of replacing them.

## S2 — OpenAI Codex CLI releases
- Checked: 2026-10-31.
- Source: [openai/codex releases](https://github.com/openai/codex/releases)
- License: Apache-2.0
- License source: [LICENSE](https://github.com/openai/codex/blob/main/LICENSE)

The repo's CHANGELOG.md is a stub pointing at the releases page; the releases
are canonical. October shipped 0.163 through 0.166.

- Takeaway: 0.166.0 adds codex doctor --network-only for focused configuration, connectivity and WebSocket diagnostics. Phantom file `src/core/doctor.ts`; job: add a scope flag so triage runs one probe group instead of the full report.
- Takeaway: 0.163.0 lets Codex run independent read-only tools in parallel, including skill, memory and conversation-history lookups. Phantom file `src/core/run/agent-loop.ts`; job: batch side-effect-free tool calls in one step to cut model round-trips per task.
- Takeaway: 0.166.0 preserves acknowledged approval and permission settings across resume and fork, and keeps reasoning-token accounting so resumed threads do not compact early. Phantom file `src/core/queue/store.ts`; job: persist approval decisions in the queued task record and restore them on resume instead of re-prompting.

## S3 — xAI Grok Build changelog and repository
- Checked: 2026-10-31.
- Source: [Grok Build changelog](https://x.ai/changelog/build)
- Source: [xai-org/grok-build](https://github.com/xai-org/grok-build)
- License: Apache-2.0 (public source mirror synced from a private monorepo; no external contributions).
- License source: [LICENSE](https://github.com/xai-org/grok-build/blob/main/LICENSE)

Releases run nearly daily (1.0.68–1.0.70 in the checked window). The Rust
repo publishes the TUI, agent runtime, tools and workspace crates for source
transparency and local builds.

- Takeaway: 1.0.70 makes /plugins count only the plugin skills that load and reports how many were skipped because they link outside the plugin folder. Phantom file `src/core/plugins/registry.ts`; job: return a structured load report of loaded, skipped and reason instead of silently dropping contributions.
- Takeaway: 1.0.69 has grok doctor warn when retired config keys like vim_mode or simple_mode remain, naming their replacements. Phantom file `src/core/doctor.ts`; job: add a retired-key check that maps old config keys to current ones.
- Takeaway: 1.0.68 makes worktree create and fork list the files that could not be copied and the mode changes that were lost, and fails cleanly instead of falling back. Phantom file `src/core/sandbox/worktree.ts`; job: surface a copy-loss report on worktree setup instead of proceeding quietly.

## S4 — DeepSeek Harness repository
- Checked: 2026-10-31.
- Source: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Source: [core subsystem doc](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- License: MIT
- License source: [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)

Developer preview; npm CLI (dsh) plus a Python SDK. Built on a Cordis
"everything is a plugin" architecture with an event-sourced session log.

- Takeaway: The agent loop is event-sourced — the driver claims a queued prompt, appends every model-visible fact to the session log, and the next step derives context from the log. Phantom file `src/core/run/streaming.ts`; job: make the durable JSONL run stream the reconstruction source for a run's context rather than a render detail.
- Takeaway: Core ships only the session log, prompt assembly, tool registry and the loop; every other capability composes as plugins behind one context API. Phantom file `src/core/plugins/host-api.ts`; job: pick one hardcoded subsystem and move it behind the existing plugin host boundary.

## S5 — Nous Research Hermes Agent repository
- Checked: 2026-10-31.
- Source: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- Source: [releases](https://github.com/NousResearch/hermes-agent/releases)
- License: MIT
- License source: [LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)

v0.22.5 shipped 2026-10-22. Positioned as a self-improving agent: skill
creation, memory nudges, cross-session search, one gateway serving chat
platforms, and five sandbox backends.

- Takeaway: FTS5 session search with model summarization gives the agent cross-session recall of how it solved past problems. Phantom file `src/core/knowledge/index.ts`; job: index durable run streams for full-text recall queries.
- Takeaway: The learning loop creates skills after complex tasks and improves them during use. Phantom file `src/core/learn/playbooks.ts`; job: extend distillation so recovered failures also draft playbook candidates, not only successful swarms.
- Takeaway: Five sandbox backends (local, Docker, SSH, Singularity, Modal) sit behind one executor contract. Phantom file `src/core/sandbox/autonomous-env.ts`; job: define a backend interface so a new executor environment is configuration, not new code.
- Takeaway: Subagents run isolated conversations and can drive tools through Python RPC scripts, collapsing multi-step pipelines into zero-context-cost turns. Phantom file `src/core/run/orchestrator.ts`; job: let a worker run a scripted tool pipeline without routing every step through model context.

## S6 — OpenClaw repository
- Checked: 2026-10-31.
- Source: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- Source: [agent harness plugin doc](https://github.com/openclaw/openclaw/blob/525db34f/docs/plugins/sdk-agent-harness.md)
- License: MIT
- License source: [LICENSE](https://github.com/openclaw/openclaw/blob/main/LICENSE)

A local control-plane Gateway owns sessions, tools, events and channel
connections; agent harnesses are a plugin seam, not a provider.

- Takeaway: The agent-harness contract has the core resolve provider, model, auth, thinking level, context budget, transcript, workspace, sandbox and tool policy first — the harness only runs the prepared attempt. Phantom file `src/core/run/engine-registry.ts`; job: split engine specs into a core-owned prepare stage and an engine-owned attempt stage so a new backend can never skip policy.
- Takeaway: openclaw doctor --fix rewrites legacy runtime config keys into canonical refs instead of only warning. Phantom file `src/core/doctor-fix.ts`; job: add migrations for known-retired config keys to the self-heal path.
- Takeaway: Runtimes are selected per model through agentRuntime.id on model entries, so one assistant mixes engine backends per model family. Phantom file `src/core/run/model-profile.ts`; job: allow a model-scoped engine override in model profiles.

## S7 — Google Gemini CLI changelogs
- Checked: 2026-10-31.
- Source: [changelogs index](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md)
- Source: [releases](https://github.com/google-gemini/gemini-cli/releases)
- License: Apache-2.0
- License source: [LICENSE](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE)

Stable v0.65.0 and v0.66.0 shipped 2026-10-20 and 2026-10-27; nightly and
preview channels run alongside.

- Takeaway: v0.64.0 serialized file tool operations with atomic writes and added atomic state persistence that restores a backup on corruption. Phantom file `src/core/util/durability.ts`; job: audit state stores so every write is atomic and a corrupt read restores the last good copy.
- Takeaway: v0.66.0 suppresses interactive SSH and credential prompts in spawned shell and git environments so runs cannot hang on hidden prompts. Phantom file `src/core/sandbox/safe-git.ts`; job: audit every spawned VCS and remote environment for prompt suppression beyond GIT_TERMINAL_PROMPT.
- Takeaway: v0.65.0 enforces read-only workspace settings in untrusted folders rather than denying or fully trusting them. Phantom file `src/core/sandbox/policy.ts`; job: evaluate a read-only tool mode for unenrolled repositories.

## S8 — opencode releases and changelog
- Checked: 2026-10-31.
- Source: [opencode changelog](https://opencode.ai/changelog)
- Source: [anomalyco/opencode releases](https://github.com/anomalyco/opencode/releases)
- License: MIT
- License source: [LICENSE](https://github.com/anomalyco/opencode/blob/dev/LICENSE)

Releases now publish from anomalyco/opencode (moved from sst). v2.2.2–v2.2.5
landed 2026-10-29 through 2026-10-30.

- Takeaway: compaction.buffer accepts a percentage of each model's context window so one setting fits small and large models. Phantom file `src/core/run/context-window.ts`; job: accept a fractional reserve in addition to fixed token counts.
- Takeaway: Provider context-window errors trigger compaction instead of stopping the session. Phantom file `src/core/run/agent-loop.ts`; job: on a context-overflow error, refit context and retry once before failing the task.
- Takeaway: MCP servers sending stdio messages larger than 10 MiB no longer get disconnected, and large messages read faster. Phantom file `src/core/mcp-gateway.ts`; job: audit the downstream stdio frame limit and read path for large tool results.
- Takeaway: Calls to a tool named bash route to shell with identical permissions, while a real plugin tool named bash still wins. Phantom file `src/core/run/agent-loop.ts`; job: support a compat alias that remaps a retired tool name without weakening its permission checks.

## Ranked ideas — highest gain for merge speed or autonomy

1. Compact-and-retry on context overflow (S8, reinforced by S1's idle
   compaction): turns a whole class of dead runs into finished work —
   `src/core/run/agent-loop.ts` plus `src/core/run/context-window.ts`.
2. Prepared-attempt engine split (S6): core resolves policy once, engines
   only execute, so new backends cannot weaken authority —
   `src/core/run/engine-registry.ts`.
3. Parallel read-only tool batching (S2): fewer model round-trips per step
   shortens every dispatched job — `src/core/run/agent-loop.ts`.
4. Structured plugin load report (S3): silent skips are the top cause of
   "why didn't my skill run" debugging loops —
   `src/core/plugins/registry.ts`.
5. Scoped and self-fixing doctor (S2 --network-only, S6 doctor --fix, S3
   retired-key warnings): faster triage and less config debt before dispatch —
   `src/core/doctor.ts` plus `src/core/doctor-fix.ts`.

## Coverage notes

Every listed source was reachable on 2026-10-31; nothing above is filled in
from memory. Caveats: Claude Code is proprietary, so only the public
changelog and release notes informed S1 — no source or design documents were
copied. The Codex repo's CHANGELOG.md is a stub; the releases page is the
canonical record. xai-org/grok-build is a transparency mirror that accepts no
external contributions. No source that was sought went unreached; candidate
sources beyond the eight above (e.g. Cursor and Aider notes) were not needed
to meet the requested coverage and were not consulted.
