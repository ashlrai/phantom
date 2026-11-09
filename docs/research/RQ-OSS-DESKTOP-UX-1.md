# RQ-OSS-DESKTOP-UX-1 — Desktop app UX + OSS “Grok Bot–like” local agent hunt

- **Date:** 2026-11-06 · **Lane:** devin (non-Grok) · **Tier:** frontier · **Status:** complete
- **Mission:** survey OSS desktop agent UIs for Phantom's workbench; answer whether an
  open-source local re-implementation of the Grok Bot app (or close cousins) exists and what
  its license allows. Proprietary products (Grok Bot, Cursor, Claude Desktop, Windsurf,
  Conductor, Codex app, LM Studio, Devin UI) are **design inspiration only** — no code,
  assets, or reconstructed source is reused.
- **Method:** web search (GitHub, HN, r/LocalLLaMA, Product Hunt, reviews) followed by
  direct LICENSE-file verification on each repo's default branch. Licenses were read from
  the checked-in `LICENSE` / `LICENSE.md` / `LICENSE.txt` / `LICENSE-*` files (raw text),
  not from README claims. ~50 candidates reviewed; every `adopt`/`fork` below is a
  permissive OSI license.

## 1. Ranked adoption table

| rank | project | url | license (SPDX) | license_url | effort (S/M/L) | impact (1-5) | Phantom fit note | recommend |
|------|---------|-----|----------------|-------------|----------------|--------------|------------------|-----------|
| 1 | Emdash | https://github.com/generalaction/emdash | Apache-2.0 | https://github.com/generalaction/emdash/blob/main/LICENSE | L | 5 | Electron multi-agent orchestrator: parallel CLI agents, git-worktree isolation, plan→run→diff→PR. Mirrors dispatchd + worktree model almost exactly; the strongest skeleton for a Phantom desktop shell. | fork |
| 2 | Vibe Kanban | https://github.com/BloopAI/vibe-kanban | Apache-2.0 | https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE | M | 5 | Kanban of agent tasks (todo → running → review → PR) with per-task worktrees and diff/PR review — a near-1:1 ask → job → PR mapping for the console. React pieces liftable. | adopt |
| 3 | Goose | https://github.com/block/goose | Apache-2.0 | https://github.com/block/goose/blob/main/LICENSE | M | 4 | Block's local agent: desktop app (Electron) + CLI, MCP client, sessions/recipes, tool-permission prompts. Reference implementation of "MCP-native desktop agent" and reusable session UX. | adopt |
| 4 | Paradev (ex-Superset) | https://github.com/ParadevAI/Paradev | MIT | https://github.com/ParadevAI/Paradev/blob/main/LICENSE | L | 4 | Open-source Codex-app/Conductor alternative — a grid of parallel coding agents on local worktrees. Alternative fork skeleton to Emdash; high community momentum (~16k★). | fork |
| 5 | OpenHands | https://github.com/All-Hands-AI/OpenHands | MIT | https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE | M | 4 | Agent-run web UI: streaming event timeline, file/diff/terminal/browser panes, microagent + skill library. Concepts and React components port well to `src/web-ui` job runs. | adopt |
| 6 | Crystal | https://github.com/stravu/crystal | MIT | https://github.com/stravu/crystal/blob/main/LICENSE | S | 4 | Small Electron app for parallel Claude Code worktree sessions. Minimal and readable — cheap to mine for session-tree, git-status and notification-panel code. | adopt |
| 7 | Dyad | https://github.com/dyad-sh/dyad | Apache-2.0 (except `src/pro/`) | https://github.com/dyad-sh/dyad/blob/main/LICENSE | M | 3 | Local-first Electron agent app: plan/approve/diff/undo loops, OS-keychain BYOK. Good desktop shell patterns; keep clear of the `src/pro/` carve-out. | inspire-only |
| 8 | Jan | https://github.com/menloresearch/jan | Apache-2.0 | https://github.com/menloresearch/jan/blob/main/LICENSE | S | 3 | Tauri local-model manager/desktop. Model catalog + local-server UX is directly relevant to oMLX. Note: relicensed from AGPL-3.0 to Apache-2.0 (2025) — confirm the checked-in header before any fork. | inspire-only |
| 9 | Cherry Studio | https://github.com/CherryHQ/cherry-studio | AGPL-3.0 | https://github.com/CherryHQ/cherry-studio/blob/main/LICENSE | S | 3 | Closest OSS analog to a Grok/Claude-Desktop chat shell (Electron, multi-provider, MCP, knowledge bases). Copyleft ⇒ ideas only, zero code. | inspire-only |
| 10 | Open WebUI | https://github.com/open-webui/open-webui | Custom (BSD-3-based + branding clause + CLA) | https://github.com/open-webui/open-webui/blob/main/LICENSE | S | 3 | Richest local-first chat shell (tools, artifacts, workspaces, RBAC). Branding must not be removed >50 users ⇒ source-available; study flows, take no code. | inspire-only |
| 11 | Cline | https://github.com/cline/cline | Apache-2.0 | https://github.com/cline/cline/blob/main/LICENSE | S | 3 | Canonical agent permission-prompt and diff-approve UX inside a React webview. Concepts port cleanly; code is VS Code-extension-bound. Roo Code (Apache-2.0) is the same family. | inspire-only |
| 12 | Zed | https://github.com/zed-industries/zed | GPL-3.0 (editor/agent) + Apache-2.0 (GPUI, some crates) | https://github.com/zed-industries/zed/blob/main/LICENSE-GPL | S | 3 | Agent panel, thread view, inline assist UX worth studying. GPL covers the editor ⇒ inspiration only; Apache crates are Rust, not directly reusable in TS. | inspire-only |

### Also reviewed (license-verified, not ranked)

| project | license | verdict (one line) |
|---|---|---|
| Aider-AI/aider | Apache-2.0 | inspire-only — TUI; ask→edit→commit loop and repo-map UX worth borrowing |
| RooCodeInc/Roo-Code | Apache-2.0 | inspire-only — Cline-family modes/permission UX |
| sst/opencode | MIT | inspire-only — TUI + provider-agnostic agent; session UX ideas |
| charmbracelet/crush | FSL-1.1-MIT (+CLA) | inspire-only — source-available until 2-year MIT conversion; no competing-use reuse |
| Pythagora-io/gpt-pilot | FSL-1.1-MIT | inspire-only — same FSL constraint |
| meltylabs/melty | MIT | skip — VS Code fork, stalled (download via Google Form) |
| plandex-ai/plandex | MIT | inspire-only — plan/diff TUI concepts |
| voideditor/void | Apache-2.0 | skip — repo archived 2026-06-02; live forks only if maintained |
| trypear/pearai-app + pearai-submodule | MIT (app) / Apache-2.0 (submodule) | skip — stale; 2024 license incident resolved but low value now |
| sourcegraph/cody → cody-public-snapshot | Apache-2.0 (frozen snapshot) | skip — Cody moved to a private repo in 2025; snapshot is archived/dead code |
| danny-avila/LibreChat | MIT | inspire-only — chat shell; presets/agents UX ideas |
| lobehub/lobe-chat | "LobeHub Community License" (Apache-2.0 + commercial-derivative restriction) | inspire-only — derivatives need a commercial license |
| Mintplex-Labs/anything-llm | MIT | inspire-only — workspace/RAG shell ideas |
| nomic-ai/gpt4all | MIT | inspire-only — local-model chat shell |
| TabbyML/tabby | Apache-2.0 (`ee/` carve-out) | inspire-only — self-hosted copilot server, not a desktop shell |
| stackblitz-labs/bolt.diy | MIT | inspire-only — in-browser builder; prompt→project UX |
| onlook-dev/onlook | Apache-2.0 | inspire-only — design-tool side of agent UX |
| mem0ai/mem0 | Apache-2.0 | inspire-only — memory layer, not a desktop UI |
| wandb/openui | Apache-2.0 | inspire-only — prompt→UI generation |
| screenpipe/screenpipe | "Screenpipe Commercial License" (non-commercial only; older versions MIT) | inspire-only — commercial use needs paid Enterprise plan |
| OpenInterpreter/open-interpreter | Apache-2.0 | inspire-only — terminal agent + OS-mode concepts |
| Kochava-Studios/witsy | AGPL-3.0 | inspire-only — Electron "universal MCP client"; copyleft |
| getAsterisk/claudia | AGPL-3.0 | inspire-only — gorgeous Claude Code session GUI (Tauri); copyleft |
| winfunc/opcode | AGPL-3.0 | inspire-only — same niche as claudia |
| Bin-Huang/chatbox | GPL-3.0 | inspire-only — chat shell; copyleft |
| nanbingxyz/5ire | Modified Apache-2.0 + commercial restrictions | inspire-only — enterprise/brand clauses |
| NitroRCr/AIaW | BSD-3-Clause | inspire-only — "AI as Workspace" Quasar/Electron shell |
| vastsa/PI-Desktop | LGPL-3.0 | inspire-only — modular agent workspace w/ plugin panels; weak copyleft, fork = LGPL obligations |
| Origin-AI-IDE/origin | Apache-2.0 | inspire-only — tiny Tauri AI IDE; plan/ask/agent modes |
| aidanhibbard/pyrola (vixl) | MIT | inspire-only — young BYOK desktop agent (Tauri) |
| miskibin/agent-ui | UNVERIFIED — no LICENSE file in repo | skip until a license lands |
| AidenNovak/modus | UNVERIFIED — repo 404/moved | skip |
| AnRkey/Grok-Desktop | GPL-2.0 | skip — webview wrapper of grok.com, not a reimplementation |
| liaan/grok-desktop | MIT | inspire-only — tiny Grok Build GUI over ACP; useful ACP-client reference |
| JaydenCJ/grok-build-desktop | All-rights-reserved custom license | skip — no permission to copy/modify granted |
| b-nnett/grok-bot-0.18-reconstructed | NO LICENSE + derived from proprietary binary | skip — see §2 warning; do not clone, read, or reuse |
| LM Studio | Proprietary freeware (Element Labs ToS; only `lmstudio-js` SDK is MIT) | skip as code — UI ideas only |

## 2. Grok-Bot-like subsection

**Does a credible OSS local desktop agent app exist that is a reimplementation or close
functional peer of Grok Bot / the Cursor Chat shell?**

- **A literal reimplementation: no.** The one attempt found,
  `b-nnett/grok-bot-0.18-reconstructed` (3.6k★, archived 2026-08-28), is a source-oriented
  reconstruction of a shipped proprietary binary. It carries **no LICENSE at all** (default
  copyright = all rights reserved), its bootstrap downloads and extracts the proprietary
  app, and its provenance makes any copy legally unsafe. Recommendation: **do not clone,
  do not read its "source", do not reuse manifests or UI text.** Treat it as radioactive
  and as proof that "OSS Grok Bot" is marketing bait, not a real thing.
- **Close functional peers: yes, and they are legitimately open source.** The honest OSS
  answer to "Grok Bot at home" is the *parallel coding-agent desktop* genre that matured in
  2025–2026 — Electron/Tauri shells that orchestrate local CLI agents on git worktrees —
  plus the chat shells. Best candidates for Phantom:
  1. **Emdash (Apache-2.0)** — orchestrates multiple coding agents in parallel across
     worktrees; the closest structural peer to Phantom's own dispatchd + queue model.
  2. **Paradev / ex-Superset (MIT)** — Conductor/Codex-app alternative; agent grid +
     embedded terminal + worktrees.
  3. **Goose desktop (Apache-2.0)** — the most mature *single-agent* local desktop shell:
     MCP-native, sessions/recipes, permission prompts, provider-agnostic.
     Honorable mentions: Vibe Kanban (Apache-2.0, kanban of agent runs), Crystal (MIT,
     small Electron session multiplexer), liaan/grok-desktop (MIT, thin GUI over the Grok
     Build CLI via ACP — pattern reference only).
- **What Phantom may legally reuse:** MIT/Apache-2.0/BSD-3 code may be copied, modified and
  vendored with license notices preserved (Apache-2.0 additionally requires retaining
  NOTICE and marking modifications; it carries a patent grant). **AGPL/GPL/LGPL projects
  (Cherry Studio, Witsy, claudia, opcode, Chatbox, Zed editor, PI-Desktop) and
  source-available projects (Open WebUI, LobeChat, Crush, GPT Pilot, 5ire, screenpipe) yield
  ideas and UX flows only — no code.** For FSL-1.1 code (Crush, GPT Pilot), each release
  converts to MIT two years after publication; older releases are technically re-usable but
  cold.
- **Clear statement:** Grok Bot, Cursor, Claude Desktop, Windsurf, Conductor, the Codex
  app, LM Studio and similar proprietary products are **inspiration only**. Phantom must
  not copy, reimplement from leaked/reconstructed source, or paste proprietary code or
  assets. When in doubt about a repo (no LICENSE, custom license, reconstructed source):
  `license=UNVERIFIED` ⇒ **skip**.

## 3. Desktop UX patterns worth stealing (ideas only)

Mapped to Phantom's workbench (`phm serve` console, Fleet/Home surfaces, Verse, COS API,
dispatchd, lanes, router-queue, worktrees). No code copied.

- **Global ask bar → queued job.** One pinned natural-language box everywhere (header /
  tray / hotkey) that turns text into a structured job card (title, lane, tier guess) and
  returns an ack chip linking to the run. Phantom already has the seam:
  `POST /api/verse/fleet/cos/ask` + `phm queue`. (Seen in: Conductor, Devin UI, agent-ui.)
- **Multi-agent sidebar with live status.** Left rail listing each running agent: status
  dot, lane/branch/worktree badge, model, burn/quota meter, "needs you" flag. One click =
  jump to that run's timeline. (emdash, Paradev, Crystal.)
- **Unified run timeline.** A single collapsible event stream per job — prompt, plan,
  tool calls, terminal runs, file diffs, test output, retries, permission prompts,
  checkpoints — with timestamps and deep-linkable entries. Phantom's job-latency
  boundaries (queued → launch → checkout_complete → finish → ci_start → ci_complete →
  merged) are a ready-made spine. (OpenHands, Emdash, Modus.)
- **Plan-mode card with a Build button.** Read-only exploration phase writes a reviewable
  `plan.md` rendered as a card; approving it starts execution. Fits Phantom's RQ/plan →
  READY line hand-off. (OpenHands, agent-ui, Origin, Dyad.)
- **Diff-first review surface.** Per-file diff tabs, inline stage/commit/push, branch +
  upstream status, "what changed since you looked" — the review step is a first-class
  panel, not a git command. (Vibe Kanban, Emdash, Dyad.)
- **Permission-prompt rail, not modal spam.** Approvals as queued first-class objects with
  risk tiers (read vs. write vs. network vs. spend), remember-this-rule, and a visible
  audit trail — aligned with Phantom's Security GATES rather than raw shell asks.
  (Cline/Roo, Origin, Goose.)
- **Checkpoints and one-click rollback.** Pre-run snapshot + undo button so an agent run
  is never a commitment. (Dyad, claudia, bolt.diy.) Pairs naturally with Phantom's
  worktree-per-job model.
- **Needs-you inbox + digest notifications.** Completions and blocks surface as a small
  inbox/tray badge with a digest, mirroring Phantom's needs-you/drafts concepts — approval
  required before any outbound send. (Vibe Kanban, OpenHands, Phantom drafts.)
- **Session resume + CLI-history import.** Import prior agent sessions, resume mid-thread,
  compact-context affordance when history gets long. (agent-ui, Crystal, OpenHands.)
- **BYOK/provider catalog with keychain storage.** Model/provider picker that reflects
  exactly what the underlying agent reports — never a silent fallback; keys in the OS
  keychain, usage totals per provider. (Jan, Origin, Dyad, grok-build-desktop's honest
  model selector.)
- **In-app update/feed rail.** Release notes + update status as a quiet rail, not a
  startup modal; plus a fleet feed ("what shipped in the last 24h") matching Phantom's
  recorded-merges Home view. (Zed, Cherry Studio.)

## 4. Proposed next Phantom READY lines

Job titles Core could queue after this research (one-liner + acceptance hint). Not
queued here — these are proposals only.

1. **RQ-DESKTOP-SHELL-SPIKE-1** — Spike: evaluate Emdash vs. Paradev (Apache-2.0 / MIT)
   as the skeleton for a Phantom desktop shell wrapping `phm serve` + dispatchd status.
   *Acceptance:* comparison doc + build-from-source attempt notes; license/NOTICE
   obligations listed; no production changes.
2. **RQ-JOB-TIMELINE-1** — Unified job-run timeline component in `src/web-ui` rendering
   the queued→launch→checkout→finish→ci→merged event spine per job, with collapsible
   tool/terminal/diff entries. *Acceptance:* component + unit test against fixture
   `jobs.jsonl`; real runs render end-to-end.
3. **RQ-ASK-BAR-1** — Global ask bar in the console (and tray entry) posting to
   `POST /api/verse/fleet/cos/ask`, rendering the ack/status chip and needs-you state.
   *Acceptance:* happy path + `VERSE_INVALID`/`COS_REFUSED` handling; mutation-gate
   respected; tests added.
4. **RQ-PERMISSION-UX-1** — Permission-prompt model spec for agent actions (risk tiers,
   remember-rule, audit trail) mapped onto Security GATES v3. *Acceptance:* proposal doc
   + JSON schema; Security review requested; no implementation yet.
5. **RQ-OSS-LICENSE-POLICY-1** — Vendor/derivative policy page capturing this report's
   adopt/fork/inspire-only/skip lists and NOTICE obligations for Apache-2.0 imports.
   *Acceptance:* `docs/` page + checklist wired into PR template.

## 5. Sources

Searched: GitHub repo search + awesome-lists, HN, r/LocalLLaMA mentions, Product Hunt,
vendor docs. LICENSE verification was done by reading the license file on each default
branch (raw.githubusercontent / github blob pages) on 2026-11-06. Star counts are
approximate as of that date.

Ranked candidates (repo + license):

- https://github.com/generalaction/emdash · https://github.com/generalaction/emdash/blob/main/LICENSE
- https://github.com/BloopAI/vibe-kanban · https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE
- https://github.com/block/goose · https://github.com/block/goose/blob/main/LICENSE
- https://github.com/ParadevAI/Paradev (redirects from github.com/superset-sh/superset)
- https://github.com/All-Hands-AI/OpenHands · https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE
- https://github.com/stravu/crystal · https://github.com/stravu/crystal/blob/main/LICENSE
- https://github.com/dyad-sh/dyad · https://github.com/dyad-sh/dyad/blob/main/LICENSE
- https://github.com/menloresearch/jan · https://github.com/menloresearch/jan/blob/main/LICENSE
- https://github.com/CherryHQ/cherry-studio · https://github.com/CherryHQ/cherry-studio/blob/main/LICENSE
- https://github.com/open-webui/open-webui · https://github.com/open-webui/open-webui/blob/main/LICENSE
- https://github.com/cline/cline · https://github.com/cline/cline/blob/main/LICENSE
- https://github.com/zed-industries/zed · https://github.com/zed-industries/zed/blob/main/LICENSE-GPL · https://github.com/zed-industries/zed/blob/main/LICENSE-APACHE

Also reviewed:

- https://github.com/continuedev/continue/blob/main/LICENSE · https://github.com/voideditor/void
- https://github.com/trypear/pearai-app · https://github.com/trypear/pearai-submodule/blob/main/LICENSE
- https://github.com/sourcegraph/cody-public-snapshot · https://github.com/Aider-AI/aider/blob/main/LICENSE.txt
- https://github.com/RooCodeInc/Roo-Code/blob/main/LICENSE · https://github.com/sst/opencode/blob/dev/LICENSE
- https://github.com/charmbracelet/crush/blob/main/LICENSE.md · https://github.com/Pythagora-io/gpt-pilot/blob/main/LICENSE
- https://github.com/danny-avila/LibreChat/blob/main/LICENSE · https://github.com/lobehub/lobe-chat/blob/main/LICENSE
- https://github.com/Mintplex-Labs/anything-llm/blob/master/LICENSE · https://github.com/nomic-ai/gpt4all
- https://github.com/TabbyML/tabby/blob/main/LICENSE · https://github.com/stackblitz-labs/bolt.diy/blob/main/LICENSE
- https://github.com/onlook-dev/onlook · https://github.com/mem0ai/mem0/blob/main/LICENSE
- https://github.com/wandb/openui/blob/main/LICENSE · https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md
- https://github.com/OpenInterpreter/open-interpreter/blob/main/LICENSE · https://github.com/Kochava-Studios/witsy
- https://github.com/getAsterisk/claudia/blob/main/LICENSE · https://github.com/winfunc/opcode/blob/main/LICENSE
- https://github.com/Bin-Huang/chatbox/blob/main/LICENSE · https://github.com/nanbingxyz/5ire/blob/main/LICENSE
- https://github.com/NitroRCr/AIaW/blob/master/LICENSE · https://github.com/vastsa/PI-Desktop/blob/main/LICENSE
- https://github.com/Origin-AI-IDE/origin/blob/main/LICENSE · https://github.com/aidanhibbard/pyrola/blob/main/LICENSE
- https://github.com/meltylabs/melty · https://github.com/plandex-ai/plandex/blob/main/LICENSE
- https://github.com/miskibin/agent-ui (no LICENSE) · https://github.com/AnRkey/Grok-Desktop/blob/main/LICENSE
- https://github.com/liaan/grok-desktop · https://github.com/JaydenCJ/grok-build-desktop/blob/main/LICENSE
- https://github.com/b-nnett/grok-bot-0.18-reconstructed (no LICENSE — skip)
- https://github.com/lalomorales22/Grok-Desktop · https://lmstudio.ai/app-terms
- https://techcrunch.com/2024/09/30/y-combinator-is-being-criticized-after-it-backed-an-ai-startup-that-admits-it-basically-cloned-another-ai-startup/ (PearAI license incident)
- https://sourcegraph.com/blog/open-sourcing-cody (historical; repo since privatized)
