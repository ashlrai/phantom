# Desktop UX audit

Audited November 24, 2026. Reference: the requested chat-first assistant bar.
Evidence: Phantom's own installed window and this repository's source. No
competitor app, personal app database or credentials were inspected.

The captured window URL carries v=3.30.39; the source package is 3.30.73.
Screenshots therefore establish the starting experience, not acceptance of this
patch. The launch screen progressed to the console; launch latency was not timed.
The Agents window confirms empty-column dashes, no filter recovery action and
dense horizontal controls.
Screenshots are retained locally and excluded from the public change.

## Ranked gaps

Impact and effort are qualitative engineering estimates, not measured scores.
Ordering favors incorrect context and recoverable dead ends before restructuring.

| Rank | Gap and evidence | Impact | Effort | Disposition |
| --- | --- | --- | --- | --- |
| 1 | [Checks](src/web-ui/routes/verse/agents/ChecksPanel.tsx) retains old agent data while switching; late reads can replace newer results. | High | Medium | Fixed: identity-scoped pane, canceled superseded reads and stale-result guards. |
| 2 | Checks first-load errors have no retry; refresh errors disappear behind cached results. | High | Small | Fixed: compact recovery card, Retry checks, explicit stale-data warning. |
| 3 | [Agents board](src/web-ui/routes/verse/agents/AgentsBoard.tsx) has no recovery when filters hide every card. | High | Small | Fixed: explain the empty result and clear repository, text and Done history filters together. |
| 4 | Initial board loading and failed reads resemble four empty columns with zero counts. | High | Small | Fixed: explicit loading status; failed reads retain the existing Retry board read action without invented counts. |
| 5 | Empty columns use dashes instead of explaining their purpose. Confirmed in the installed window. | Medium | Small | Fixed: brief guidance for Working, Needs you, Ready for review and Done. |
| 6 | [Agent details](src/web-ui/routes/verse/agents/AgentDetails.tsx) silently ignores invalid spend-cap input. | Medium | Small | Next: accessible validation using the existing Input error prop. |
| 7 | The inline plan approval textarea lacks a label. | Medium | Small | Next: label the editor and retain existing approval gating. |
| 8 | Setup-log read failures are swallowed; the previous run's text can remain visible. | Medium | Medium | Next: scope the log to its run, show loading/error/retry states. |
| 9 | Preview [agent chat roster](src/web-ui/routes/verse/agents/AgentChatRoster.tsx) shows titles without unread counts or clear status. | High | Medium | Coordinate with the multi-owner roster; preserve owner identity and privacy rules. |
| 10 | Agent context is split between Overview/Checks, chat Tasks/Files/Context, routines and the Computer tools sheet. | High | Large | Follow-up design: one agent-scoped information pane with working links into existing tools. |

## Existing strengths and coordination

The [chat sidebar](src/web-ui/routes/verse/Sidebar.tsx) already has search,
unread indicators and running/failure states. The board already uses task cards,
and AgentDetails provides inline plan approval. The chat dock already exposes
task/tool progress. Preserve those primitives; future milestone summaries should
link to the existing task detail instead of creating another progress source.
New agent and keyboard launch already exist. The current patch reuses Button,
EmptyState, spacing and typography tokens rather than introducing a new system.

[Live resource work #8619](https://github.com/ashlrai/phantom/pull/8619) owns
usage freshness and resource rows. [Multi-owner design #8579](https://github.com/ashlrai/phantom/pull/8579)
owns the identity/grant direction and planned roster integration. Their paths are
unchanged. No matching open PR was returned for the exact job or ChecksPanel
search. The previously recorded Checks 500 failure now runs as an active test.

## Delivery and acceptance

One focused change covers reliable agent context and recoverable empty states.
All work remains uncommitted for the bridge handoff. No PR, merge, publication,
native build, signing, notarization or live installation was performed.
Component tests exercise real UI and fetch handling with synthetic responses,
including delayed reads, StrictMode, retries and agent/chat switches. Exact
commands and results were recorded in the worker's `BRIDGE_NOTES.md`. Hosted
checks and rendered acceptance of a newly packaged desktop build remain downstream gates.
