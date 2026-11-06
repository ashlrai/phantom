# Harness inspiration digest

Research cutoff / checked: 2026-10-31. Dates below distinguish publication from
inspection; undated living pages are not assigned invented release dates.
All summaries are paraphrases except the explicitly marked quotation. Upstream
claims describe their projects, not measured results for Phantom. No upstream
code is copied. Follow-up work: [READY bets](READY-HARNESS-BETS.md).

Phantom's root LICENSE is MIT. MIT upstream material can be incorporated with
its required notices; Apache-2.0 portions retain their own license/notice and
modification obligations rather than becoming MIT-only. Proprietary Claude Code
runtime material has no verified reuse grant here. These are reuse constraints,
not a dependency audit: every bet below uses independent code and adds no package.

## S1 — Boris Cherny: repeatable loops versus dynamic orchestration

- Checked: 2026-10-31. Published: not stated on the inspected transcript.
- Source: [Anthropic's Ramp office-hours transcript](https://claude.com/customers/ramp-boris-office-hours).
- Establishes: Cherny distinguishes repetitive PR/CI maintenance loops from workflows whose next optimization steps are unknown; he describes orchestrated subagents as additional test-time compute.
- Direct quotation (Boris): “So loops are repetitive work. And dynamic workflows are dynamic work.”
- Limits: this is workflow advice, not a graph algorithm, general throughput guarantee, or permission to remove Phantom's gates. Rahul's trace-analysis and least-privilege remarks are Rahul's, not Boris's. The attempted January X thread was inaccessible (403), so its popular numbered tips are not treated as verified here.
- License: public transcript is reference material, not an open-source software grant; link and paraphrase, do not transplant implementation.
- Phantom relevance: diagnose the failing retrieval or dispatch step before adding more agents (B1, B3, B5).

## S2 — DeepSeek Harness is an actual public project

- Checked: 2026-10-31. Published: no initial release date established.
- Source: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), [agent API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md).
- Establishes: DeepSeek Harness (`dsh`) identifies itself as DeepSeek AI's open-source harness, built on Cordis with an everything-is-a-plugin architecture; README labels it developer preview with breaking changes. The agent package exposes create/resume, followup, steer, inject, cancel and idle APIs, with a separate driver supplying the model loop. Initiator attribution is process-local and must be carried explicitly across durable boundaries.
- Limits: this is not DeepSeek-R1, a model API wrapper, or proof of production reliability. A public harness exists at this cutoff; no earlier release date is inferred.
- License: [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE); copied substantial portions require copyright and permission notices. Dependencies and third-party notices need separate review. These bets independently implement ideas, without adding Cordis or dsh.
- Phantom relevance: preserve provenance across boundaries and distinguish delivery from execution (B2, B4).

## S3 — Hermes Agent: explicit learning and recall

- Checked: 2026-10-31. Published: living README, release date not established.
- Source: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
- Establishes: README describes skill creation/refinement, persistent memory nudges, FTS5 conversation search with summarization, isolated subagents, and multiple terminal backends.
- Limits: these are documented features; the README's exclusivity and cost claims are not independently validated. No personal conversations or production logs were inspected.
- License: [MIT](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE); retain required notices if reusing code, review optional integrations separately. No skill or memory implementation is imported.
- Phantom relevance: improve evidence quality before expanding recall or automatic memory writes (B1–B3); protected `src/core/memory/**` is outside scope.

## S4 — OpenClaw: gateway and execution boundaries

- Checked: 2026-10-31. Published: living README, release date not established.
- Source: [openclaw/openclaw](https://github.com/openclaw/openclaw).
- Establishes: README describes a local Gateway, chat/native clients, interchangeable harness/model plugins, and a trusted-gateway/untrusted-execution architecture.
- Limits: local state does not imply prompts never reach configured providers; README explicitly describes provider/platform traffic. No claim of security equivalence with Phantom.
- License: [MIT](https://github.com/openclaw/openclaw/blob/main/LICENSE); preserve notices for reuse and inspect plugin licenses independently. No runtime or plugin code copied.
- Phantom relevance: metadata-only failure visibility should preserve untrusted message framing and convey no execution authority (B4).

## S5 — Claude Code: incremental sessions and observable lifecycle fixes

- Checked: 2026-10-31. Published: 2025-11-26 for the harness article; changelog inspected at 2.1.316 (publication date not stated in the raw entry).
- Source: [Anthropic harness engineering](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents), [current changelog](https://code.claude.com/docs/en/changelog), [subagent documentation](https://code.claude.com/docs/en/sub-agents).
- Establishes: article describes initializer/coding roles and incremental progress artifacts across context windows. Changelog 2.1.316 reports fixes for orphan shell processes and inherited subagent models changing when background work wakes them. Subagent docs describe separate contexts and scoped capabilities.
- Limits: reported fixes are not proof that Phantom has those bugs. Article is Anthropic engineering advice, not a Boris quotation. No leaked source was consulted.
- License: [Claude Code license](https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md) reserves rights and refers use to commercial terms. Public docs/changelog do not authorize copying proprietary runtime code; any separate SDK/example license must be checked individually.
- Phantom relevance: maintain explicit outcome/state distinctions and test wake/failure cases with synthetic inputs (B4, B5).

## S6 — Codex: reusable harness and client protocol

- Checked: 2026-10-31. Published: 2026-08-19 for the engineering article; 2026-10-09 for CLI 0.162.1 in the changelog.
- Source: [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform), [official changelog](https://learn.chatgpt.com/docs/changelog).
- Establishes: article describes app-server threads, turns, events, approvals and configured sandbox boundaries as reusable harness capabilities. CLI 0.162.1 reports a multiline asynchronous-question crash fix and compatibility checks narrowed to explicit feature overrides.
- Limits: an embedding protocol is not a recommendation to replace Phantom's orchestrator, nor authorization to alter sandbox/approval controls. Changelog details are a dated sample, not a claim that 0.162.1 is latest.
- License: [Codex repository Apache-2.0](https://github.com/openai/codex/blob/main/LICENSE); redistribution requires license/notice handling and marking modified files where applicable. Hosted services/model access have separate terms. No upstream code reused.
- Phantom relevance: return inspectable evidence and deferral reasons to existing desktop/agent clients (B1, B5).

## S7 — xAI engineering publication and Grok Build changelog

- Checked: 2026-10-31. Published: 2026-07-15 for source release; 2026-10-23 for Build 1.0.70.
- Source: [Grok Build source announcement](https://x.ai/news/grok-build-open-source), [Build changelog](https://x.ai/changelog/build), [linked source project](https://github.com/xai-org/grok-build).
- Establishes: announcement describes published context assembly, tool dispatch, TUI and extension system. Changelog 1.0.70 reports counting only loadable plugin skills and explaining skipped links outside the plugin folder; 1.0.68 reports worktree copy/mode-loss diagnostics.
- Limits: Build is distinct from Grok Bot. Public publication/changelog inspection required no account, token, billing change or Bot access; no performance or security guarantee inferred.
- License: [Grok Build Apache-2.0](https://github.com/xai-org/grok-build/blob/main/LICENSE); preserve license/notices and mark modifications for reuse, check dependencies separately. Announcement text is not itself a software license. No code copied.
- Phantom relevance: explain exclusion/failure through bounded structured diagnostics rather than silent omission (B2, B4, B5).

## Phantom inspection and interpretation boundary

Read-only baseline: fetched `origin/master` and HEAD both
`0a5fa2cfd4aaea75cf799598e1f8f1e279418782`; reviewed AGENTS.md and CODEOWNERS before editing.

| Inspected file | Existing behavior and concrete seam |
| --- | --- |
| `src/core/knowledge/index.ts` | Bounded, scrubbed local indexing; persisted chunk guard checks primitive types but not finite ordered line ranges or vector contents. B2 targets that guard, preserving local-only indexing. |
| `src/core/knowledge/ask.ts` | Cosine and keyword scores can enter one raw sorted list; zero-score keyword hits survive. Empty index already abstains, but retrieval failure can reach a general-answer prompt with no context. B1/B3 target those seams, retaining explicit cloud opt-in. |
| `src/core/fleet/event-bus.ts` | Best-effort lifecycle handlers; thread delivery frames untrusted input, reduces TTL, records metadata hops and aggregate failures. B4 adds optional failure observation without replay or dispatch authority. |
| `src/core/fabric/concurrent-dispatch.ts` | Capacity-governed planning, candidate/tier filters, kill checks and optional host admission already exist. Unassigned items lack per-item reason codes. B5 projects existing decisions without increasing slots. |

For Mason's graph-engineering interpretation, this handoff proposes the following
design lens (author synthesis, not a verified statement of Mason's views or an
upstream quotation): represent evidence, tasks and outcomes as nodes with typed
provenance/dependency edges; distinguish observed, inferred and authorized edges.
This handoff applies that lens to existing seams. It does not establish
that Boris, DeepSeek or any other source advocates Mason's graph design, and it
does not claim a supplied verbatim statement from Mason. A graph-engine rewrite,
automatic memory mutation and new durable event infrastructure are deferred.
