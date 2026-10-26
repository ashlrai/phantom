<a id="phantom-vision"></a>

# Phantom vision

Phantom is an open-source personal assistant for engineering work, and it is not tied to one model vendor. You ask in a chat. It acknowledges, keeps working after you look away, and reports the result. It remembers, runs routines on a schedule or when an event arrives, and can hand pieces of the work to teammate agents under one orchestrator. Risky actions wait on an approval card. A sidebar shows the agents, the routines, and this machine. Any model or coding agent can sit behind the chat, through a subscription login, a command-line agent, an API key, or a local model that listens only on this machine unless you persist an opt-in. A hosted assistant or a cloud coding agent can be a backend too. MCP is how any resource plugs in, with a registry-style install, and Phantom Secrets holds keys so the values are not shown to models. The aim is the most useful fully autonomous open-source engineering project: it proceeds on its own, and it still keeps main-branch merges frontier-only, keeps local or unparseable endpoints out of merge and credential roles, and keeps Tier-1 paths protected.

This page is the product direction. It is not a claim that the resident daemon is commissioned. Daemon and conductor activation trust roots are empty arrays in `src/core/daemon/activation-permit.ts` (`DAEMON_ACTIVATION_TRUST_ROOTS`, `GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS`). A standing-grant public key is a different list and is present in `src/core/authority/trust-roots.ts`.

## The four pillars

### 1. Assistant UX

The home surface is a chat. You ask, the assistant acknowledges, the work continues off that turn, and a result comes back. Memory persists. Routines run on a schedule and on events. Teammate agents work under an orchestrator. Consequential actions show an approval card. A sidebar lists agents, routines, and the machine.

### 2. Provider-agnostic

Any model or coding agent plugs in through one of four doors: a subscription login, a command-line agent, an API key, or a local model. Local listeners stay on loopback unless the operator persists an opt-in. A hosted assistant platform or a cloud coding agent can be a backend. Adding a backend does not grant merge authority.

### 3. Connect any resource

MCP is the plug-in standard. Any MCP server can be connected. Phantom Secrets stores keys, and secret values are not shown to models. Install follows a registry-style flow: pick a server, confirm it, and it is available to the assistant.

### 4. Proactive and fully autonomous

The assistant acts without asking for every step. Approval is for consequential actions. These safety invariants stay:

- A merge to the main branch requires a frontier engine and a concrete model on the merge-authority list.
- A local or unparseable endpoint does not receive merge authority or a credential role.
- Tier-1 paths stay on the owner lane. The fleet does not merge them.

## Where the code is today

Checked against this tree. **Shipped** means the path does the thing. **Partial** means a real slice exists and the pillar is not met. **Missing** means the pillar's shape is not in the product.

| Capability | Pillar | Status | What the code does |
| --- | --- | --- | --- |
| Chat as a surface | 1 | Partial | A fresh install opens Chat (`DEFAULTS.section` in `src/web-ui/routes/verse/verse-ui-store.ts`). The rail order is Command, Fleet, Growth, Mind, Chat, Agents in the same file. |
| Ask, continue, report back | 1 | Partial | A chat turn is accepted with HTTP 202 (`sendJson(res, 202, result)` in `src/core/verse/verse-api.ts`). Events keep streaming, and `src/web-ui/routes/verse/chat/sidebar-model.ts` can mark a finished turn unread. `src/web-ui/routes/verse/chat/TasksTray.tsx` counts this turn's running tool calls and other chats with a turn in flight. There is no acknowledgement message followed by a later result message. |
| Persistent memory | 1 | Shipped | One `MEMORY.md` per project is injected into chat turns (`src/core/verse/project-memory.ts`, called from `src/core/verse/verse-api.ts`). Sessions persist under `sessions/<id>.json` (`src/core/verse/session-store.ts`). |
| Scheduled and event routines | 1 | Shipped | Trigger kinds are `github-issues`, `ci-red`, `schedule`, `webhook`, and `telegram` (`src/core/automations/types.ts`). `scheduleAutomationsTick` in `src/core/automations/scheduler.ts` runs from the console server. The gear tray renders them in `src/web-ui/routes/verse/sections/AutomationsSection.tsx`. |
| Teammate agents and an orchestrator | 1 | Partial | `src/web-ui/routes/verse/sections/AgentsSection.tsx` switches between a coding-agent board and proactive profiles. `planGoal` and `runGoal` in `src/core/run/orchestrator.ts` run a goal task graph. Those paths are not one chat orchestrator. Proactive coordination replies `dispatchAuthorized: false` (`src/core/verse/proactive-coordination-api.ts`). |
| Approval cards | 1 | Partial | Proposal review is `src/web-ui/routes/verse/approvals/ApprovalDetail.tsx`, opened from `src/web-ui/routes/verse/shell/NeedsYouDrawer.tsx` and summarized by `src/web-ui/routes/verse/command/NeedsYouCard.tsx`. Destructive MCP tools wait for Allow once, Allow for chat, or Deny (`src/core/verse/verse-mcp-grants.ts`). The card is not a row in the chat transcript. |
| Sidebar for agents, routines, and the machine | 1 | Missing | `buildSidebar` in `src/web-ui/routes/verse/chat/sidebar-model.ts` lists chats (all, running, needs you, pinned) and saved projects. Agents are a rail section, routines are the gear tray, and the host is elsewhere. |
| Subscription login | 2 | Partial | Native profiles are `codex`, `claude`, and `grok` (`src/core/resources/native-profile.ts`), and profile prepare prints that vendor's login argv. Devin login is separate (`src/core/devin/cli-probe.ts`). There is no cursor-agent profile. Gemini is not a native profile. |
| Command-line agents | 2 | Partial | Built-in ids include `claude`, `codex`, `grok-cli`, `devin-cli`, `hermes`, `opencode`, `aw`, and `ashlrcode` (`src/core/run/engine-registry.ts`). A config entry can add an engine, and an entry with no tier is dropped. There is no `gemini` CLI id and no `cursor-agent` id. |
| API key | 2 | Partial | In-process clients read provider env keys, including `GEMINI_API_KEY` (`src/core/run/router.ts`). A `phm_` placeholder is refused and `revealSecret` returns null (`src/core/integrations/secrets.ts`), so the Secrets vault is not an API-key source for those clients. |
| Local model, loopback by default | 2 | Shipped | `gateBindHost` in `src/core/local-runtime/llama/config.ts` keeps llama-server and its proxy on `127.0.0.1` unless `models.llamaServer.allowNonLoopback` is persisted. `src/core/run/local-inference.ts` refuses a non-loopback base URL unless `allowRemote` is persisted and the URL is https. |
| Hosted assistants and cloud coding agents | 2 | Partial | `src/core/cloud/launcher.ts` starts Claude cloud sessions from a pinned seat. `src/core/devin/service.ts` launches Devin sessions. `src/core/openai-agents/client.ts` is a read-only client and rejects a non-loopback gateway. There is no Cursor cloud-agent backend. |
| MCP as the plug-in | 3 | Shipped | `src/core/mcp-gateway.ts` aggregates downstream stdio servers and namespaces their tools. The console's own tool server is `src/core/verse/verse-mcp.ts`. |
| Any MCP server | 3 | Partial | Discovery accepts any stdio `command` in an `mcpServers` map (`src/core/mcp-registry.ts`). `McpServerSpec` in `src/core/types.ts` has `command`, `args`, and `env`, and no URL. |
| Phantom Secrets, values hidden from models | 3 | Partial | The companion contract is in `docs/AGENT-TOOLCHAIN.md`: secret values are not returned to the agent. This repo redacts env values before display (`redactEnv` in `src/core/mcp-registry.ts`) and will not treat a `phm_` placeholder as a key (`src/core/integrations/secrets.ts`). |
| Registry-style install | 3 | Partial | `src/cli/mcp.ts` can list, doctor, install this repo's gateway into a client config, and merge known companions into `~/.ashlr/settings.json`. Discovery reads local files. Nothing in `src/core/mcp-registry.ts` installs an arbitrary server from a public registry. |
| Act under a signed grant | 4 | Partial | Grant, switch, and kill switch are specified in `docs/STANDING-AUTHORITY.md` and implemented under `src/core/authority/`. `autoMergeProposal` in `src/core/inbox/merge.ts` runs only when `cfg.foundry.autoMerge.enabled` is true, and that flag defaults off. `applyProposal` in `src/core/inbox/apply.ts` still requires status `approved` and `confirmed: true`. |
| Ask only when the action is consequential | 4 | Partial | Destructive tools and proposal review are gated, as the approval-card row says. Inbox apply still asks for a confirm on every apply. There is no separate class for reversible work. |
| Main merges stay frontier-only | 4 | Shipped | `evaluateMergeAuthority` in `src/core/inbox/merge.ts` authorizes a merge only when `engineTier` is `frontier` and the concrete model is on `cfg.foundry.mergeAuthority`. A `:default` model is refused. |
| Local or unparseable endpoints stay out of merge and credential roles | 4 | Partial | Non-frontier tiers, including local, have no main merge authority (same function). `isFrontierJudgeId` in `src/core/fleet/reviewer-independence.ts` refuses `local`, `unknown`, and a local runtime whose model name looks like a vendor. An unparseable endpoint is not treated as free (`endpointMeteredness` and `decidePermission` in `src/core/policy/local-only.ts`). Abliterated models are refused in coder, reviewer, and planner (`src/core/run/local-inference.ts`). A normal loopback model can still run those roles: `supportsRoleExecution` in `src/core/run/role-invocation.ts` allows `local-coder` and `llama-server`. |
| Tier-1 paths stay protected | 4 | Shipped | `src/core/authority/protected-paths.ts` sends a diff that touches a protected path to the owner lane. The fleet does not merge it. |

## Top gaps

Ranked by how much they block the paragraph above. Effort is the size of the first slice: **small** is one module and its tests, **medium** is a few modules and their tests. None of these slices weaken the safety invariants.

1. **Acknowledgement, background work, and a result.** Pillar 1. Medium. First slice: when a turn is accepted, write one short assistant line that names the task, and when that turn finishes while the chat is not the focused one, write a result line. The unread row in `sidebar-model.ts` can keep using that line. Do not add a new merge or tool permission.

2. **Sidebar entries for agents, routines, and the machine.** Pillar 1. Small. First slice: under the existing chat sidebar, add three read-only groups that open the current Agents section, the current Automations section, and a host summary (loopback console, local bind host, and whether `~/.ashlr/KILL` is present). No new authority.

3. **One orchestrator for teammate agents, inside the chat.** Pillar 1. Medium. First slice: from the open chat, choose an existing coding agent and hand it the current task, then show that agent's status and result in the same transcript. Leave `runGoal` on its current path for this slice. Proactive profiles stay unable to dispatch until a later slice.

4. **Approval only for consequential actions.** Pillar 4. Medium. First slice: under a signed standing grant, allow one reversible class (opening a draft pull request that does not touch a protected path) to proceed without a second inbox confirm. Keep `evaluateMergeAuthority`, credential-role checks, destructive-tool confirms, and `protected-paths.ts` as they are. `applyProposal` today confirms every apply, so the slice is a narrow exception plus tests that main merge, local credential use, and Tier-1 diffs still refuse.

5. **A registry-shaped MCP install, local first.** Pillar 3. Medium. First slice: a command that writes one stdio server into `~/.ashlr/settings.json`, redacts env values in every output, and reuses the digest confirm in `src/core/verse/mcp-mutation.ts`. No network fetch in this slice. A later slice can feed that writer from a registry record.

6. **One more command-line agent, with no merge authority.** Pillar 2. Medium. First slice: add either a Gemini CLI or a Cursor agent CLI as a built-in engine id with an install probe, tier `local` or `mid`, and no entry on `mergeAuthority`. Subscription login for that agent can wait. Config-only engines already exist; this slice makes one missing public CLI first-class.

7. **HTTP MCP servers.** Pillar 3. Medium. First slice: allow an optional URL on `McpServerSpec`, parse it in `mcp-registry.ts`, and connect one remote server from `mcp-gateway.ts` beside stdio. Keep env redaction. Do not treat a URL as loopback unless the host is `localhost`, `127.0.0.1`, or `::1`.

8. **Chat first on the rail.** Pillar 1. Small. First slice: put Chat first in `VERSE_SECTIONS` so it is the first rail item. Keep the fresh-install default and the rule that a later launch returns to the saved section.

## Code follow-ups

These conflict with this page or still teach the old direction. This change does not edit them.

- `northStarDocSummary()` in `src/core/ecosystem/map.ts` still reads `docs/NORTH-STAR.md` and appends a yield paragraph of its own. `test/m231.north-star-grounding.test.ts` requires the old vision sentence and the old three pillar names. `docs/NORTH-STAR.md` keeps a stub for that loader. Point the loader at this page, then delete the stub.
- `applyProposal` in `src/core/inbox/apply.ts` refuses unless the proposal is `approved` and `confirmed` is true. That is stricter than pillar 4. Gap 4 is the first exception to consider.
- `src/core/verse/proactive-coordination-api.ts` returns `dispatchAuthorized: false` on the coordination reply. Profiles do not dispatch.
- `supportsRoleExecution` allows `local-coder` and `llama-server` into role execution. Pillar 4 says a local endpoint does not get a credential role. The merge gate already refuses local tiers. Closing the role gap needs its own reviewed change.
- `revealSecret` in `src/core/integrations/secrets.ts` returns null, and `explainProviderKey` can report `vault-transport-not-supported`. In-process API clients do not read the Secrets vault.
- `DAEMON_ACTIVATION_TRUST_ROOTS` and `GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS` are empty, so resident daemon and conductor activation stay refused. Filling those roots is owner commissioning, not a docs edit.
