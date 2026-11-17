# Competitive roadmap, November 2026

Status: research and proposal only. This document grants no access, spending,
install, send, merge or release permission. [AGENTS.md](../../AGENTS.md) and
the [end-state spec](ENDSTATE.md) stay the authority, and any build taken from
it must name the matching ENDSTATE decision (D1 to D7).

Evidence baseline: Phantom `master` at `f7f5828b8`, read from source on
2026-11-17. Public sources were read on 2026-11-17. Every external claim links
to its source. **Unverified** marks a claim taken from a secondary page, a
search summary or a page whose text did not render. Phantom statuses come from
reading source and docs, not from running the system. Desktop and mobile
screens were not checked visually.

Status key for Phantom: **has** means a concrete implementation exists,
**partial** means a real implementation with a material piece missing,
**missing** means no implementation was found.

## 1. Capability matrix

Columns list what each product publicly documents. A blank cell (`-`) means
the capability was not found in the sources read, not that it is absent.

| Capability | Phantom status and evidence | Devin | Grok Bot (xAI) | Claude Code / Desktop | OpenAI Codex | Cursor | Gumloop | Open source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orchestration and parallel workers | **has**: `contrib/mac/dispatchd.py`, `src/core/swarm/runner.ts`, `docs/QUEUE.md` | Managed Devins: a coordinator splits work across isolated VMs [A1]; Dynamic Workflows: deterministic Python with resume and replay [A2] | Bots run in parallel, 24/7 [X1] | Subagents, agent view, agent teams [C1] | Parallel threads, worktrees, automations [O1] | Cloud agents, `/in-cloud` subagents [U1] | Long-running agents (**unverified**) [G2] | Orca fleet orchestrator [S1]; LangGraph checkpoints [S2]; CrewAI flows [S3] |
| Subagents inside one session | **partial**: `src/core/run/delegation-scope.ts`, `src/core/verse/handoff.ts`; no `phm subagent` command | Fusion lead plus sidekick [A3] | Bots bring in other Bots [X1] | Own context, tools, model per subagent; background chains up to 5 deep [C2] [C3] | Side-chat tabs [O2] | Background subagents [U1] | Background subagent requests (**unverified**) [G1] | Goose resumable delegates (**unverified**) [S4] |
| Agent messaging and group chat | **has**: `docs/AGENT-BUS.md`, `docs/AGENT-CHAT.md`, `src/cli/bus.ts` | A session can message other sessions via Automations [A4] | Bots work together in Slack threads and hand off [X2] | Agent teams: shared task list and messages (experimental) [C4] | - | Slack thread agents [U2] | Messaging over chat, Slack, Teams, iMessage, email (**unverified**) [G2] | OpenClaw multi-agent channel bindings [S5] |
| Memory, skills, wiki | **has**: `docs/MEMORY-FOUNDATION.md`, `docs/SKILLS.md`, `src/cli/wiki.ts` | Bot memory files [A5]; skills made from sessions [A1]; DeepWiki with diagrams [A6] | Per-Bot memory with rules and dated work log; skill from one demonstration [X3] [X4] | Project memory, skills, plugins [C5] | Skills [O1] | Automation memories, `@cursor remember` rules [U3] [U4] | Persistent workspace (**unverified**) [G3] | Aider repo map [S6]; CrewAI skill search [S3] |
| Computer and browser use | **has**: `docs/DESKTOPCTL.md`, `docs/DESKTOP-OPERATOR.md`, `desktop/src-tauri/src/browser_pane.rs` | Desktop Preview tab with element picker [A7] | Persistent cloud computer, own screen per Bot, logins persist [X5] | Computer use, browser pane [C6] | Hosted desktop or browser per automation session [O3] | - | Browser allow and block lists (**unverified**) [G1] | - |
| Connectors, MCP, plugins | **partial**: `docs/CONNECTORS.md`, `docs/AGENT-MCP-CLI.md`, `docs/PLUGINS.md`; no hosted marketplace | Public Bot templates marketplace [A5] | MCP, APIs, custom tools [X2] | Plugins, connectors, MCP [C5] | Plugins, custom providers [O2] | MCP in automations [U3] | MCP credential pinning per tool (**unverified**) [G3] | OpenHands MCP settings and agent profiles [S7] |
| Scheduling and event triggers | **has**: `docs/ROUTINES.md`, `src/core/automations/engine.ts`, `docs/SLACK-BUS-INGRESS.md` | Slack, Teams, GitHub, GitLab, Linear, schedule, webhook; preflight filter that can split work items [A4] | Schedule, Slack, GitHub, Linear, Sentry, PagerDuty, email, webhook [X4] | Schedule, API, GitHub triggers [C7] | Cron automations API [O3]; session webhooks [O4] | Schedule, GitHub, GitLab, Slack, Linear, webhook [U3] | Gmail triggers (**unverified**) [G3] | OpenHands prebuilt automations [S8] |
| Observability UI and replay | **partial**: `desktop/README.md`, `src/core/verse/trace.ts`, `src/web-ui/routes/verse/fleet-timeline/`; no cross-provider replay | Agent Command Center kanban [A8]; session event search [A9] | Watch the Bot's screen live [X5] | Agent view [C1] | Agent command center task search [O2] | - | Per-task guardrail evidence (**unverified**) [G1] | Goose context-window viewer (**unverified**) [S4] |
| Cost, usage and model routing | **has**: `docs/ROUTER-GATEWAY.md`, `src/cli/budget.ts`, `docs/FLEET-USAGE-PACING.md` | Lite, Normal, Ultra, Fusion modes [A10]; cost by model and savings in `/session-stats` [A3] | - | Fallback model chain up to 3 [C3] | Custom model providers [O2] | - | - | OpenHands LiteLLM budgets [S9]; mini-SWE-agent cost limit [S10] |
| Review loops and autofix | **has**: `docs/CROSS-REVIEW.md`, `src/core/run/best-of-n.ts`, `phm autopilot` | Devin Review Auto-Fix [A11]; Review Analytics by reviewer and instruction version [A9] | Auto Review of each action [X3] | PR monitoring through CI [C6] | Structured review findings, AGENTS.md review rules [O5] | Bugbot autofix, learned rules, PR approval of low-risk changes [U4] [U3] | - | OpenHands PR review automation [S8] |
| Multi-machine work | **has**: `docs/NODE-ROUTER.md`, `docs/AGENT-NETWORK.md`, `docs/CLOUD.md` | Child sessions on separate machines [A5] | Shared account computer [X5] | Local, cloud, SSH; Remote Control from phone [C6] [C8] | Outbound WebSocket self-hosted executor [O6]; phone as control plane [O7] | Cloud environment snapshots, local-to-cloud handoff [U1] | - | Orca remote runtime [S1] |
| Lifecycle hooks | **partial**: `src/core/verse/terminal-agent-hooks.ts`, `src/core/plugins/types.ts`; Claude and Codex callbacks only | - | - | Shell, HTTP, MCP, prompt and subagent hooks [C9] | - | - | Guardrails on every tool (**unverified**) [G1] | Goose stop, approval and tool hooks (**unverified**) [S4] |
| ACP, SDK, IDE | **partial**: `src/core/devin/acp-bridge.ts`, `docs/OPENAI-AGENTS-INTEGRATION.md`; no Phantom ACP server | Runs Codex CLI, Claude Agent, OpenCode, Junie, Gemini CLI over ACP [A12] | - | Agent SDK [C5] | `codex exec-server` [O6] | - | - | OpenHands ACP agent profiles [S7] |
| Boards and campaigns | **has**: `src/cli/fleet-work-board.ts`, `src/cli/universe-campaign.ts`, `src/web-ui/routes/verse/fleet-board/` | Boards and Campaigns: no public doc found (**unverified**) | - | - | - | - | - | - |
| Owner channels, voice, mobile | **has**: `docs/OWNER-THREAD.md`, `docs/IMESSAGE.md`, `docs/REMOTE-PHONE.md`, `desktop/src-tauri/src/voice/README.md` | Bots in Slack and iMessage [A5] | Voice calls, Meet and Zoom [X1] | Dispatch from phone [C6] | Phone control plane [O7] | Voice chat [U5]; mobile app [U1] | Email inboxes for agents (**unverified**) [G3] | OpenClaw multi-channel routing [S5] |
| Self-improvement and evals | **has**: `docs/EVAL-PASSK.md`, `docs/SKILLS.md`, `phm improve`; outcome-driven router tuning is still an ENDSTATE goal (D5) | Session analysis, skill improvement [A1] | - | - | - | - | Organization-wide agent evals (**unverified**) [G2] | Aider writes much of its own code [S6] |
| Planning and spec approval | **has**: `src/cli/spec.ts`, `src/cli/swarm.ts` | Ask mode with Plan and handoff [A13] | Approval cards [X3] | - | Goals [O7] | - | - | LangGraph interrupts with strict resume [S2] |

## 2. Top 15 gaps, ranked

Ranking rule: leverage for a vendor-neutral, autonomous, self-improving
factory that routes across every connected subscription and API. Gaps that
remove a provider lock or close the outcome-to-router feedback loop rank
first. Each design extends an existing seam, as ENDSTATE requires. Module and
command names are proposals; none exist yet. Tiers follow
[tier-scaled scope](../QUEUE.md#tier-scaled-session-scope).

### 1. Phantom as an ACP host and ACP server (frontier)

Gap: Phantom drives Devin through `src/core/devin/acp-bridge.ts` and other
agents through per-app adapters. Devin Desktop runs any ACP agent over JSON-RPC
on stdio [A12] [A14], and OpenHands treats ACP agents as profiles [S7]. One
protocol would make every coding CLI a routable lane.

Design:
- Modules: `src/core/acp/client.ts` (generic stdio JSON-RPC client generalized
  from `acp-bridge.ts`), `src/core/acp/server.ts` (exposes `phm` as an ACP
  agent), `src/core/acp/registry.ts`.
- Commands: `phm acp agents --json`, `phm acp add <id> --command "<argv>"`,
  `phm acp probe <id> --json`, `phm acp serve --stdio`.
- Data: `acp.agent.v1 { id, command: string[], env_secret_names: string[],
  capabilities: { fs, terminal, mcp }, lane: string, tier_ceiling, cost_class }`.
  The router treats each entry as a resource in the D1 shared work market.

### 2. Outcome-driven router tuning (frontier)

Gap: pass^k scores and review outcomes are advisory (`docs/EVAL-PASSK.md`);
ENDSTATE D5 is not built. Devin reports fixed, rejected and ignored review
outcomes per reviewer and instruction version [A9]. Fusion reports cost by
model and savings [A3].

Design:
- Modules: `src/core/router/outcomes.ts` (joins `metrics/jobs.jsonl`, review
  decisions and pass^k), `src/core/router/tune.ts` (bounded weight proposals).
- Commands: `phm route tune --dry-run --json`, `phm route tune --apply --max-shift 0.1`,
  `phm route outcomes --lane <id> --json`.
- Data: `router.outcome.v1 { job_id, lane, model, tier, work_class, merged: bool,
  ci_first_pass: bool, review_findings: {fixed, rejected, ignored}, cost_usd|null,
  wall_s }`; `router.weights.v1 { work_class, lane, weight, evidence_n, updated_at }`.
  Unknown stays null; a weight shift below a minimum sample count is refused.

### 3. Cross-provider subagents (`phm subagent`) (frontier)

Gap: delegation contracts exist but provider-native children vary by adapter
(inventory item 16). Claude subagents carry their own context, tools and model
[C2]; Fusion pairs a frontier lead with a cheap sidekick [A3].

Design:
- Modules: `src/core/subagent/spawn.ts` on top of `delegation-scope.ts` and the
  router; `src/core/subagent/result.ts`.
- Commands: `phm subagent spawn --parent <session> --tier fast --task "<t>" --json`,
  `phm subagent list --parent <session> --json`, `phm subagent result <id> --json`.
- Data: `subagent.v1 { id, parent_id, depth, tier, lane|null, tools_allowed,
  write_scope: string[], max_tokens, max_cost_class, state, result_ref }`.
  Depth is capped at 3 (Claude caps background chains at 5 [C3]).

### 4. Resumable workflow journal with replay (work)

Gap: swarms and campaigns resume, but no deterministic per-call journal replays
completed steps. Devin Dynamic Workflows record every agent call and replay
finished agents on resume [A2]; LangGraph resumes per interrupt ID [S2]; CrewAI
keeps outputs across human-feedback resume [S3].

Design:
- Modules: `src/core/workflow/journal.ts`, `src/core/workflow/runner.ts`
  (reuses `src/core/swarm/runner.ts` executors).
- Commands: `phm workflow run <file.ts|json> --json`, `phm workflow resume <id>`,
  `phm workflow show <id> --json`.
- Data: append-only `workflow.step.v1 { run_id, step_key, input_hash, output_ref,
  status, lane, cost_usd|null }`. A step whose `input_hash` matches a completed
  row is replayed, not re-run.

### 5. Cross-agent lifecycle hook registry (work)

Gap: hooks exist only per launch for Claude and Codex
(`src/core/verse/terminal-agent-hooks.ts`). Claude hooks can be shell, HTTP,
MCP, prompt or subagent handlers and fire inside subagents [C9].

Design:
- Modules: `src/core/hooks/registry.ts`, `src/core/hooks/emit.ts`; adapters
  translate native events into one shape.
- Commands: `phm hooks list --json`, `phm hooks add --event pre_tool --run "<cmd>"`,
  `phm hooks test --event stop --json`.
- Data: `hook.event.v1 { event: "session_start"|"pre_tool"|"post_tool"|"stop"|"needs_input",
  agent, session_id, subagent_id|null, tool|null, args_digest }`; handler reply
  `{ decision: "allow"|"block"|"ask", reason }`. Hooks cannot widen grants.

### 6. Per-tool policy rules judged at call time (work)

Gap: Phantom gates by action class and grants (`AGENTS.md`). Gumloop applies
allow, block or approve rules to any tool and plain-language app rules per call
(**unverified**) [G1]; Grok Auto Review checks each action [X3].

Design:
- Modules: `src/core/policy/tool-rules.ts`, evaluated from the hook registry
  (gap 5) `pre_tool` event.
- Commands: `phm policy rules --json`, `phm policy add "<rule text>" --scope <repo|lane>`,
  `phm policy explain --tool <name> --args <file> --json`.
- Data: `policy.rule.v1 { id, scope, match: { tool, arg_pattern|null },
  effect: "allow"|"block"|"ask", text|null, judge_tier: "fast" }`, with every
  decision appended to `metrics/policy.jsonl`.

### 7. Automation preflight and trigger breadth (work)

Gap: routines cover schedules, GitHub, webhooks and Telegram
(`src/core/automations/engine.ts`). Devin adds a preflight LLM or script that
filters events and splits them into work items [A4]; Grok routines add Sentry,
PagerDuty and email [X4].

Design:
- Modules: `src/core/automations/preflight.ts`, `src/core/automations/sources/{linear,sentry,pagerduty,email}.ts`.
- Commands: `phm automations add --template sentry-triage --preflight <script> --json`,
  `phm automations preflight test <id> --event <file> --json`.
- Data: `automation.preflight.v1 { kind: "llm"|"script", tier, prompt|null,
  script|null }` returning `{ drop: bool, items: [{ title, needs, min_tier }] }`;
  each item becomes a D1 work-market job.

### 8. Session-to-skill capture (work)

Gap: skills are learned from merged PRs (`docs/SKILLS.md`). Devin creates and
improves skills from sessions [A1]; Grok turns one demonstration into a skill
[X4]; Cursor stores learned review rules [U4].

Design:
- Modules: `src/core/skills/capture.ts` (reads session transcript traces from
  `src/core/verse/trace.ts`).
- Commands: `phm skills capture --session <id> --dry-run --json`,
  `phm skills capture --session <id> --apply`, `phm skills remember "<rule>" --repo <r>`.
- Data: `skill.draft.v1 { name, trigger, steps: string[], checks: string[],
  boundaries: string[], source_session, scrubbed: true }`. Drafts go through
  the existing scrub and cap rules.

### 9. Environment snapshots for remote nodes (work)

Gap: node leases exist (`docs/NODE-ROUTER.md`) but a new node rebuilds each
repo. Cursor snapshots cloud environments from `.cursor/environment.json` [U1];
Codex runs a self-hosted executor that connects outbound over WebSocket [O6].

Design:
- Modules: `src/core/node/env-snapshot.ts`, `src/core/node/outbound.ts`.
- Commands: `phm node env build <repo> --json`, `phm node env list --json`,
  `phm node join --outbound <url>`.
- Data: `node.env.v1 { repo, lockfile_hash, toolchain: { node, pnpm }, setup_cmds,
  artifact_digest, built_at }`. Leases prefer nodes with a matching digest.

### 10. Cross-provider session replay and event search (work)

Gap: traces exist but replay across all providers is not established
(inventory item 8). Devin added session event search [A9]; Codex emits
session webhooks for created, action_required, in_progress, idle and failed
[O4].

Design:
- Modules: `src/core/observe/events-index.ts` (SQLite FTS over normalized
  events), `src/core/observe/webhooks.ts`.
- Commands: `phm observe search "<q>" --json`, `phm observe replay <session> --json`,
  `phm observe webhooks add <url> --events idle,failed`.
- Data: `session.event.v1 { session_id, agent, seq, ts, kind, text_digest,
  tool|null, artifact_ref|null }`. Text bodies stay local; webhooks carry IDs only.

### 11. Typed Needs-you decisions with recommendations (mid)

Gap: Phantom has Needs You inboxes (`src/web-ui/routes/verse/inbox/DecisionInbox.tsx`).
Devin Bots type each item as decision with a recommended option, review or
merge, permission request or FYI, with snooze and dismiss [A5].

Design:
- Modules: `src/core/inbox/item-kinds.ts`.
- Commands: `phm inbox list --kind decision --json`, `phm inbox answer <id> --option <n>`,
  `phm inbox snooze <id> --until <iso>`.
- Data: `inbox.item.v2 { id, kind: "decision"|"review"|"permission"|"fyi",
  options: [{ label, recommended: bool }], source, expires_at|null, snoozed_until|null }`.

### 12. Persistent agent browser profiles with human handoff (mid)

Gap: browser and desktop control are local and macOS-centric
(`docs/DESKTOP-OPERATOR.md`). Grok Bots keep logins on a persistent cloud
computer and hand the screen back for CAPTCHA or 2FA [X5].

Design:
- Modules: `src/core/browser/profiles.ts`; a handoff item kind in gap 11.
- Commands: `phm browser profile create <name> --node <id>`, `phm browser handoff <session> --json`.
- Data: `browser.profile.v1 { name, node_id, domains_allowed: string[],
  secret_names: string[], last_used_at }`. Credentials stay in Phantom Secrets.

### 13. Model fallback chains per job (mid)

Gap: routing picks a lane but no per-job ordered fallback chain was found in
`docs/ROUTER-GATEWAY.md` (**unverified**: may exist in code). Claude Code
accepts up to 3 fallback models [C3]; OpenClaw ships model fallback [S11].

Design:
- Modules: `src/core/router/fallback.ts`.
- Commands: `phm run --model auto --fallback <lane:model>,<lane:model> "<prompt>"`,
  `phm route explain --json` gains a `fallback_used` field.
- Data: job field `fallback: [{ lane, model, on: ["quota","5xx","timeout"] }]`
  (max 3), recorded as `lane_override` with a reason code.

### 14. Plugin and skill distribution (mid)

Gap: local integrity-pinned plugins exist, no distribution service
(`docs/PLUGINS.md`). Devin publishes Bot templates [A5]; Claude Code ships
plugins [C5].

Design:
- Modules: `src/core/plugins/catalog.ts` reading a signed Git-hosted index.
- Commands: `phm plugins search <q> --json`, `phm plugins install <name>@<ver> --dry-run`.
- Data: `plugin.catalog.v1 { name, version, repo, commit, sha256, capabilities,
  reviewed_by|null }`. Install stays dry run until the pin matches.

### 15. Organization-wide agent evals beyond code (fast)

Gap: pass^k covers code tasks (`benchmarks/passk/`). Gumloop added org-wide
agent evals (**unverified**) [G2]; Devin Review Analytics scores reviewers [A9].

Design:
- Modules: `src/core/eval/suites.ts` adding review and triage suites to pass^k.
- Commands: `phm eval passk --suite review --trials 3 --k 2`.
- Data: `eval.case.v1 { suite, input_ref, expected: { findings|labels }, grader: "exact"|"llm" }`.

## 3. Desktop UX patterns worth copying

| Pattern | Source | Phantom anchor |
| --- | --- | --- |
| Drag up to 8 sessions side by side; Files and Changes "since last seen" | Devin Desktop changelog [A7] | `src/web-ui/routes/verse/sections/FleetSection.tsx` |
| Preview tab with URL bar, device sizes and an element picker that sends the element to the agent | [A7] | `desktop/src-tauri/src/browser_pane.rs` |
| Kanban of local and cloud agents by status; editable queued messages; one OS notification per finish or needs-input | Agent Command Center [A8] | `src/web-ui/routes/verse/fleet-board/` |
| Artifacts rail beside chat; Agent and Ask modes in the composer | Devin release notes [A9] | `src/web-ui/routes/verse/sections/ChatSection.tsx` |
| One keystroke cycles agent mode (Cmd+.) | [A7] | `src/web-ui/routes/verse/sections/CommandSection.tsx` |
| Drag-and-drop panes for chat, diff, browser, terminal and editor; side chats | Claude Code Desktop [C6] | `src/web-ui/routes/verse/terminal/` |
| Multiple side-chat tabs; search across tasks; resume interrupted chats after a crash | Codex changelog [O2] | `src/web-ui/routes/work/sessions/SessionsView.tsx` |
| Queued prompt versus steering prompt on the phone | Codex remote [O7] | `src/web-ui/app/VerseMobileApp.tsx` |
| Watch each Bot on its own screen, take over for 2FA | Grok Bot [X5] | `src/web-ui/routes/verse/computer/` |
| Voice chat with the agent | Cursor changelog [U5] | `desktop/src-tauri/src/voice/README.md` |

## Sources

- [A1] Devin advanced capabilities: https://docs.devin.ai/work-with-devin/advanced-capabilities
- [A2] Devin Dynamic Workflows: https://docs.devin.ai/work-with-devin/dynamic-workflows
- [A3] Devin Fusion: https://docs.devin.ai/cli/fusion
- [A4] Devin Automations: https://docs.devin.ai/product-guides/automations
- [A5] Devin Bots: https://docs.devin.ai/work-with-devin/bots
- [A6] DeepWiki: https://docs.devin.ai/work-with-devin/deepwiki
- [A7] Devin Desktop changelog: https://docs.devin.ai/desktop/changelog
- [A8] Agent Command Center: https://docs.devin.ai/desktop/agent-command-center
- [A9] Devin release notes 2026: https://docs.devin.ai/release-notes/2026
- [A10] Devin agent modes: https://docs.devin.ai/get-started/first-run
- [A11] Devin Review: https://docs.devin.ai/work-with-devin/devin-review
- [A12] Devin ACP: https://docs.devin.ai/desktop/acp
- [A13] Ask Devin: https://docs.devin.ai/work-with-devin/ask-devin
- [A14] Custom ACP agents: https://docs.devin.ai/desktop/acp-custom
- [X1] Grok Bot: https://x.ai/bot
- [X2] Grok Bot overview: https://docs.x.ai/grok-bot/overview
- [X3] How Grok Bot works: https://docs.x.ai/grok-bot/how-grok-bot-works
- [X4] Skills, routines and automations: https://docs.x.ai/grok-bot/skills-routines-and-automations
- [X5] Computer and apps: https://docs.x.ai/grok-bot/computer-and-apps
- [C1] Claude Code parallel agents: https://code.claude.com/docs/en/agents
- [C2] Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- [C3] Claude Code what's new (read via search summary, **unverified**): https://code.claude.com/docs/en/whats-new
- [C4] Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- [C5] Claude Code features overview: https://code.claude.com/docs/en/features-overview
- [C6] Claude Code Desktop: https://code.claude.com/docs/en/desktop
- [C7] Claude Code scheduled tasks: https://code.claude.com/docs/en/routines
- [C8] Claude Code Remote Control: https://code.claude.com/docs/en/remote-control
- [C9] Claude Code hooks: https://code.claude.com/docs/en/hooks
- [O1] Codex long-horizon tasks: https://developers.openai.com/blog/run-long-horizon-tasks-with-codex
- [O2] Codex changelog: https://learn.chatgpt.com/docs/changelog
- [O3] Codex automations API: https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/automations/methods/create
- [O4] Agents API session webhooks: https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks
- [O5] Codex custom review rules: https://developers.openai.com/blog/custom-code-review-rules-for-codex
- [O6] Self-hosted environments: https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted
- [O7] Codex remote: https://developers.openai.com/blog/mastering-codex-remote-for-engineering
- [U1] Cursor changelog 3.7: https://cursor.com/changelog/page/5
- [U2] Cursor Slack background agents: https://cursor.com/changelog/1-1
- [U3] Cursor automations: https://cursor.com/docs/cloud-agent/automations
- [U4] Cursor Bugbot: https://cursor.com/docs/bugbot
- [U5] Cursor changelog: https://cursor.com/changelog
- [G1] Gumloop changelog summary (secondary, **unverified**): https://agenticindex.io/change-log/gumloop ; official page whose text did not render: https://www.gumloop.com/changelog
- [G2] Gumloop 13.0 summary (secondary, **unverified**): https://toolmarketcap.com/changes/gumloop-2026-10-23-bad36d16
- [G3] Gumloop changelog summary (secondary, **unverified**): https://toolfolio.com/tools/gumloop/changelog
- [S1] Orca: https://github.com/StablyAI/orca
- [S2] LangGraph 1.2.20: https://github.com/langchain-ai/langgraph/releases/tag/1.2.20
- [S3] CrewAI changelog: https://docs.crewai.com/edge/en/changelog
- [S4] Goose v1.59.0 (via secondary summary, **unverified**): https://whatsnew.fyi/product/goose
- [S5] OpenClaw multi-agent routing: https://docs.openclaw.ai/concepts/multi-agent/
- [S6] Aider release history: https://aider.chat/HISTORY.html
- [S7] OpenHands agent profiles: https://docs.openhands.dev/openhands/usage/agent-canvas/agent-profiles
- [S8] OpenHands prebuilt automations: https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations
- [S9] OpenHands Enterprise 0.105.0: https://docs.openhands.dev/enterprise/release-notes/0.105.0
- [S10] mini-SWE-agent releases: https://github.com/SWE-agent/mini-swe-agent/releases
- [S11] OpenClaw v2026.11.5: https://github.com/openclaw/openclaw/releases/tag/v2026.11.5

Not covered: Devin Campaigns and Boards had no public documentation page in the
sources searched (**unverified** whether they are public). SWE-agent coverage
is limited to mini-SWE-agent releases.
