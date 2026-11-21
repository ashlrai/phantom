# Fleet HTTP API

The machine-readable contract for this surface is [docs/api/fleet-openapi.json](https://github.com/ashlrai/phantom/blob/master/docs/api/fleet-openapi.json) (OpenAPI 3.1).
`test/fleet-openapi-coverage.test.ts` keeps it aligned with the remote gateway's reviewed route policy.

Phantom's fleet coordinates and observes local agent work, queues, controls,
and the Leader. These loopback endpoints expose projections used by the desktop
and phone. On the Mac, run records and the leader inbox normally live in
`~/.ashlr-runs/`; supported readers accept `ASHLR_RUNS_DIR` as an override.
Other projections read Phantom state under `~/.ashlr/`.
The API is designed not to serve secrets: projections scrub or refuse sensitive
content and job detail reads only an explicit allowlist of files. Missing or
degraded sources are reported as such rather than assumed healthy.

Start `phm verse --no-open`; it prints separate read and mutation tokens. See
[Verse setup](VERSE.md#start-it) for startup and token handling. GETs
require read authority: a browser read session or the read token in the
`X-Ashlr-Token` header. POST and DELETE require dispatch enabled, the separate
mutation token in `X-Ashlr-Token`, and `Content-Type: application/json` (also
for DELETE). A read cookie or read token cannot authorize mutations. The
examples use plainly fake placeholders: replace `<read-token>` or
`<mutation-token>` privately. Examples with writes change state; choose the
operation deliberately. The phone gateway has its own session and route policy;
these examples target the local server.

Every row gives a complete curl example. `none` means no query parameters are
used by that route. For paths assembled from a prefix and an ID, replace the
ID segment with an ID returned by a read; braces are notation, not part of the URL. The example IDs are placeholders. Inline response shapes
have no separately named response type; the link points to the handler or the
named nested type. Relative source links refer to the source checkout.

## Runs and job detail

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/fleet` (`CONTROL_PREFIX` + `/fleet`) | none | [FleetSnapshot](../src/core/verse/fleet-types.ts) | [source](../src/core/verse/control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet'` |
| GET | `/api/verse/fleet/history` | days, tz | [FleetHistoryResponse](../src/core/verse/fleet-history-types.ts) | [source](../src/core/verse/fleet-history.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/history?days=30&tz=0'` |
| GET | `/api/verse/fleet/grok-ultra` | none | [GrokUltraRunway](../src/core/fleet/grok-ultra-types.ts) | [source](../src/core/verse/grok-ultra-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/grok-ultra'` |
| GET | `/api/verse/fleet/runs` | none | [FleetRunsV1](../src/core/verse/fleet-runs-types.ts) | [source](../src/core/verse/fleet-runs-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/runs'` |
| GET | `/api/verse/fleet/usage/producers` | since | [UsageProducersReport](../src/core/fleet/usage-producers.ts) (`fleet.usage-producers.v1`) | [source](../src/core/verse/fleet-usage-producers-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/usage/producers?since=6h'` |
| GET | `/api/verse/fleet/runs/glance` | none | [OperatorGlance](../src/core/fleet/operator-glance.ts) | [source](../src/core/verse/fleet-runs-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/runs/glance'` |
| GET | `/api/verse/fleet/runs/inbox` | limit, source | [FleetInboxReadV1 or null](../src/core/verse/fleet-inbox-read.ts) | [source](../src/core/verse/fleet-runs-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/runs/inbox'` |
| POST | `/api/verse/fleet/runs/inbox` | none | [inline {ok, at} (201)](../src/core/verse/fleet-runs-api.ts) | [source](../src/core/verse/fleet-runs-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Please review the queue","source":"operator"}' 'http://127.0.0.1:7777/api/verse/fleet/runs/inbox'` |
| GET | `/api/fleet/job` | id (required) | [FleetJobDetailV1](../src/core/fleet/runs-job-detail.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job?id=example-job'` |
| GET | `/api/fleet/job/activity` | id (required) | [FleetJobActivityV1](../src/core/fleet/runs-job-activity.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job/activity?id=example-job'` |
| GET | `/api/fleet/job/text` | id, kind (required) | [FleetJobTextV1](../src/core/fleet/runs-job-texts.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job/text?id=example-job&kind=notes'` |
| GET | `/api/fleet/job/changes` | id (required) | [FleetJobChangesV1](../src/core/fleet/runs-job-changes.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job/changes?id=example-job'` |
| GET | `/api/fleet/job/cost` | id (required) | [FleetJobCostV1](../src/core/fleet/runs-job-cost.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job/cost?id=example-job'` |
| GET | `/api/fleet/job/window` | id (required), lines (1..200, default 40), after (tail cursor) | [FleetJobWindowV1](../src/core/fleet/job-window.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job/window?id=example-job&lines=40'` |
| GET | `/api/fleet/empties` | hours (default 24) | [EmptiesWhyReport](../src/core/fleet/empties-why.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/empties?hours=24'` |
| GET | `/api/fleet/stranded` | days (default 3, up to 90), verify (1 compares pushed branches with the local main branch) | [StrandedWorkReport](../src/core/fleet/stranded-work.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/stranded?days=3'` |
| GET | `/api/fleet` | none | [FleetStatus](../src/core/fleet/status.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet'` |
| GET | `/api/fleet/lanes` | none | [FleetLaneSnapshot](../src/core/fleet/lane-console.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/lanes'` |
| GET | `/api/fleet/message-graph` | since (10m, 2h, 1d, epoch ms or ISO; default 15m) | [FleetMessageGraph](../src/core/fleet/message-graph.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/message-graph?since=1h'` |
| GET | `/api/fleet/activity` | hours, limit | [AgentActivityReport](../src/core/fleet/agent-activity.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/activity?hours=6'` |
| GET | `/api/fleet/verified-completion` | hours (claim window, default 24, max 168) | [VerifiedCompletionReport](../src/core/fleet/agent-activity.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/verified-completion'` |
| GET | `/api/fleet/sessions` | none | [FleetSessionsV1](../src/core/fleet/runs-sessions.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/sessions'` |
| POST | `/api/fleet/pause` | none | [inline {ok, action, service, activation, fleet, mutation?}](../src/core/web/api.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{}' 'http://127.0.0.1:7777/api/fleet/pause'` |
| POST | `/api/fleet/resume` | none | [inline {ok, action, service, activation, fleet, mutation?}](../src/core/web/api.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{}' 'http://127.0.0.1:7777/api/fleet/resume'` |

## Fleet control

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/fleet/control` | none | [FleetControlStateV1](../src/core/fleet/fleet-control-types.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/control'` |
| POST | `/api/verse/fleet/control` | none | [FleetControlActionResultV1](../src/core/fleet/fleet-control-types.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"pause"}' 'http://127.0.0.1:7777/api/verse/fleet/control'` |
| GET | `/api/verse/fleet/control/queue` (VERSE_FLEET_CONTROL_QUEUE_PATH) | none | [FleetControlQueueV1](../src/core/fleet/fleet-control-types.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/control/queue'` |
| GET | `/api/verse/fleet/control/lanes` | none | [LaneTargetsV1](../src/core/fleet/runs-lane-targets.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/control/lanes'` |
| POST | `/api/verse/fleet/control/lanes` | none | [LaneTargetsV1](../src/core/fleet/runs-lane-targets.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"lane":"codex-personal","target":1}' 'http://127.0.0.1:7777/api/verse/fleet/control/lanes'` |
| GET | `/api/verse/fleet/control/switches` | none | [RunsSwitchesV1](../src/core/fleet/runs-switches.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/control/switches'` |
| POST | `/api/verse/fleet/control/switches` | none | [RunsSwitchesV1](../src/core/fleet/runs-switches.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"id":"PAUSE","on":true}' 'http://127.0.0.1:7777/api/verse/fleet/control/switches'` |
| GET | `/api/verse/fleet/control/runs/` (VERSE_FLEET_CONTROL_RUNS_PREFIX) + {runId} + /log | none | [FleetRunLogV1](../src/core/fleet/fleet-control-types.ts) | [source](../src/core/verse/fleet-control-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/control/runs/example-run/log'` |

## Orchestration journal

`GET /api/verse/fleet/control/orchestration` returns the read-only specialist
assignment journal: `schemaVersion: 1`, `authority: none`, source (`ok` or
`missing`), total, truncation, counts, unresolved reservations and the newest
25 receipts. It accepts no query parameters (400 for any query); other methods
return 405. Read failure or the five-second deadline returns 503. See
[fleet coordination](https://github.com/ashlrai/phantom/blob/master/docs/FLEET-COORDINATION.md#leader-orchestration)
and the [handler](../src/core/verse/fleet-orchestration-api.ts). An admitted
receipt proves coordination, not job execution.

## Live fleet

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/fleet/live` | none | [FleetLiveSnapshotV1](../src/core/fleet/fleet-types.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live'` |
| POST | `/api/verse/fleet/live` | none | [FleetLiveActionResult](../src/core/verse/fleet-live-api.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"pause-repo","repo":"ashlrai/example","reason":"Review"}' 'http://127.0.0.1:7777/api/verse/fleet/live'` |
| GET | `/api/verse/fleet/live/bus` | limit | [FleetBusFeedV1](../src/core/fleet/bus-feed.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/bus'` |
| GET | `/api/verse/fleet/live/queue` | limit | [FleetQueueV1](../src/core/fleet/runs-parked-queue.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/queue'` |
| GET | `/api/verse/fleet/live/drop-jobs` | none | [inline {v, items: DropJobListItem[]}](../src/core/fleet/drop-job-writer.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/drop-jobs'` |
| POST | `/api/verse/fleet/live/drop-jobs` | none | [inline {v, status, file, bytes, at} (201)](../src/core/fleet/drop-job-writer.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"id":"EXAMPLE01","lane":"claude","tier":"work","body":"Summarize the merge backlog."}' 'http://127.0.0.1:7777/api/verse/fleet/live/drop-jobs'` |
| GET | `/api/verse/fleet/live/feedback` | none | [ExecutionFeedbackRead](../src/core/verse/execution-feedback-api-types.ts) | [source](../src/core/verse/execution-feedback-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/feedback'` |
| GET | `/api/verse/fleet/live/feedback/cases/` (EXECUTION_FEEDBACK_CASE_PATH) + {caseId} | none | [ExecutionFeedbackCaseRead](../src/core/verse/execution-feedback-api-types.ts) | [source](../src/core/verse/execution-feedback-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/feedback/cases/example-case'` |
| GET | `/api/verse/fleet/graph/live` | agent (optional) | [FleetGraphLiveResponseV1](../src/core/verse/fleet-graph-live-api.ts) | [source](../src/core/verse/fleet-graph-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/graph/live'` |
| GET | `/api/verse/github/fleet-backlog` (VERSE_GITHUB_FLEET_BACKLOG_ROUTE) | repo (required) | [MergeBacklogReadV1](../src/core/fleet/merge-backlog-read.ts) | [source](../src/core/verse/github-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/github/fleet-backlog?repo=owner/example'` |

`GET /api/verse/github/fleet-backlog?repo=<owner/name>` returns one enrolled repo's open-PR merge backlog — items shaped `{number, title, headRef, updatedAt, mergeStateStatus, isDraft, job, classification, suggestedAction}` plus per-merge-state and per-action counts — cached for 60 s per repo. `suggestedAction` is `merge`, `recut`, `refresh`, `wait` or `none` from the merge-backlog planner; a `503` with `source: "gh-failed"` means gh could not answer and `items` is empty.

## Ops

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/ops/board` (VERSE_OPS_BOARD_PATH) | team | [OpsBoardV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/board'` |
| GET | `/api/verse/ops/fleet` (VERSE_OPS_FLEET_PATH) | none | [OpsFleetV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/fleet'` |
| GET | `/api/verse/ops/releases` (VERSE_OPS_RELEASES_PATH) | none | [OpsReleasesV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/releases'` |
| GET | `/api/verse/ops/leaders` (VERSE_OPS_LEADERS_PATH) | team | [OpsLeadersV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/leaders'` |
| POST | `/api/verse/ops/leaders/messages` (VERSE_OPS_LEADERS_MESSAGES_PATH) | none | [inline {ok} (201)](../src/core/verse/ops-api.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Please review the queue"}' 'http://127.0.0.1:7777/api/verse/ops/leaders/messages'` |
| GET | `/api/verse/ops/leader-journal` | none | [LeaderJournalV1](../src/core/fleet/leader-journal.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/leader-journal'` |
| GET | `/api/verse/ops/reset-releases` (VERSE_OPS_RESET_RELEASES_PATH) | none | [inline {v, generatedAt, loop, releases}](../src/core/fleet/usage-reset-release.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/reset-releases'` |
| GET | `/api/verse/ops/self-update` (VERSE_OPS_SELF_UPDATE_PATH) | none | [OpsSelfUpdateV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/self-update'` |
| POST | `/api/verse/ops/self-update` (VERSE_OPS_SELF_UPDATE_PATH) | none | [OpsSelfUpdateActionResult](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"fetch"}' 'http://127.0.0.1:7777/api/verse/ops/self-update'` |

## Leader

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/leader` | none | [LeaderStateV1](../src/core/vision/leader-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader'` |
| POST | `/api/verse/leader` | none | [inline action-dependent result](../src/core/verse/leader-api.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"dismiss","itemId":"leader:leader-question:example"}' 'http://127.0.0.1:7777/api/verse/leader'` |
| GET | `/api/verse/leader/resources` | none | [ResourceLedgerV1](../src/core/fleet/runs-resource-ledger.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/resources'` |
| GET | `/api/verse/leader/resources/usage-history` | pool | [UsageHistoryV1](../src/core/fleet/usage-history.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/resources/usage-history?pool=claude'` |
| GET | `/api/verse/leader/thread` (THREAD_PATH) | limit, before | [inline {messages: LeaderThreadMessage[]}](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/thread'` |
| POST | `/api/verse/leader/thread` (THREAD_PATH) | none | [AppendMasonMessageResult](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Please review the queue"}' 'http://127.0.0.1:7777/api/verse/leader/thread'` |
| GET | `/api/verse/leader/directives` (DIRECTIVES_PATH) | none | [inline {directives, retired}: OperatorDirective[]](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/directives'` |
| POST | `/api/verse/leader/directives` (DIRECTIVES_PATH) | none | [inline {directive, duplicate}: OperatorDirective](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Prioritize reliability","kind":"guidance"}' 'http://127.0.0.1:7777/api/verse/leader/directives'` |
| DELETE | `/api/verse/leader/directives/` (DIRECTIVE_PATH_RE) + {id} | none | [inline {directive}: OperatorDirective](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X DELETE -H 'Content-Type: application/json' -d '{}' 'http://127.0.0.1:7777/api/verse/leader/directives/example-id'` |
| GET | `/api/verse/leader/memos/` (MEMO_PATH_RE) + {id} | none | [LeaderMemo](../src/core/vision/leader-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/memos/example-id'` |
| GET | `/api/verse/leader/questions/` (QUESTION_PATH_RE or ANSWER_PATH_RE) + {questionId} | none | [inline {question: LeaderQuestionProjection, typedQuestionsSupported}](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/questions/example-question'` |
| POST | `/api/verse/leader/questions/` (QUESTION_PATH_RE or ANSWER_PATH_RE) + {questionId} + /answer | none | [AnswerLeaderQuestionResult or SubmitLeaderQuestionResult](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Proceed"}' 'http://127.0.0.1:7777/api/verse/leader/questions/example-question/answer'` |
| POST | `/api/verse/leader/actions/` (APPROVE_PATH_RE) + {actionId} + /approve | none | [ApproveLeaderActionResult](../src/core/vision/leader-thread-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{}' 'http://127.0.0.1:7777/api/verse/leader/actions/example-action/approve'` |

Computed route constants: `VERSE_FLEET_CONTROL_QUEUE_PATH` defines
`/api/verse/fleet/control/queue`; `VERSE_FLEET_CONTROL_RUNS_PREFIX` defines the
control run prefix. Ops paths use `VERSE_OPS_BOARD_PATH`,
`VERSE_OPS_FLEET_PATH`, `VERSE_OPS_RELEASES_PATH`, `VERSE_OPS_LEADERS_PATH`,
`VERSE_OPS_LEADERS_MESSAGES_PATH`, and `VERSE_OPS_SELF_UPDATE_PATH` in
[ops-types.ts](../src/core/verse/ops-types.ts). `THREAD_PATH` and
`DIRECTIVES_PATH` are built from `VERSE_LEADER_PATH`; the feedback case prefix
is `EXECUTION_FEEDBACK_CASE_PATH`; `VERSE_GITHUB_FLEET_BACKLOG_ROUTE` is the
merge-backlog read. Leader IDs are validated by the
[handler](../src/core/verse/leader-api.ts), and case IDs by the
[feedback handler](../src/core/verse/execution-feedback-api.ts).

Inbox reads accept `limit` 1–200 (default 50) and a case-insensitive `source`
filter of 1–40 letters, digits, spaces, dots, underscores or hyphens. Bus
`limit` defaults to 100 and is clamped to 1–500; live queue `limit` defaults to
25 and is clamped to 1–200. Thread `limit` and `before` paginate oldest-first;
consult [the thread limits](../src/core/vision/leader-thread.ts) for
bounds. History accepts `days` and `tz` (Date#getTimezoneOffset minutes); Ops `team` selects a valid team ID. Refer to each linked handler for
request body validation and action-specific responses.

GET `/api/verse/fleet/live/drop-jobs` takes no parameters and lists the job
files waiting in the dispatchd drop lane. It answers `{v:1, items:[{id, lane,
tier, title, bytes, ageSeconds}]}` — `lane`/`tier`/`title` null when a file
cannot be parsed — or `{v:1, items:[]}` when the lane is empty.

POST `/api/verse/fleet/live/drop-jobs` takes a JSON body `{id, lane, tier,
body}` — the id after `RQ-PHX-`, an allow-listed lane and tier, and the
prompt body — and publishes the validated job file into the drop lane. It
answers 201 `{v:1, status:'written', file, bytes, at}` on success, 400
`{status:'invalid', reasons}` on a contract violation, 409 `{status:'exists'}`
when the id is already spent, 507 `{status:'full'}` when the prompt queue
holds forty or more jobs, or 503 when the write fails.

A `400` with `VERSE_INVALID` indicates invalid input on routes using that code;
some handlers return a plain error instead. `401` means read or mutation
authority is missing or invalid; `415` means a mutation lacks JSON content type.
A `404` can mean a route is not in this build, a requested item is absent, or
mutation dispatch is disabled. A `409` can indicate a mutation hold, concurrent
action or other conflict; inspect the returned code and reason. Other route
specific errors include `INBOX_REFUSED` (422) and `INBOX_UNAVAILABLE` (503).

## Same data, other surfaces

The desktop and phone use these projections with their own session flows. The
CLI has related, independently shaped views and controls: `phm fleet status`,
`phm fleet watch`, `phm fleet lanes`, `phm fleet direction`, `phm fleet pause`,
`phm fleet resume`, and `phm fleet queue read`. The proposal inbox has
`phm inbox list`, `phm inbox show`, `phm inbox approve`, `phm inbox submit`,
`phm inbox reject`, and `phm inbox automerge`. That proposal inbox is distinct
from the runs leader inbox above. See the [fleet CLI](../src/cli/fleet.ts) and
[inbox CLI](../src/cli/inbox.ts) for flags and authority gates.

`phm fleet status` also reports disk use and the ten largest proven cleanup
candidates. `--json` adds typed `disk` data (`fleet.disk-attribution.v1`):
categories, per-job entries, source health and ranked `cleanupCandidates`.
Sizes are logical bytes, not promised physical savings; missing or partial
totals are `null` with a measured lower bound. Worktrees use the census safety
checks; job logs, publish results, prompts and notes are measured by metadata
only and retained as evidence. Active, dirty, protected and uncertain trees
are never candidates. This command deletes nothing. Roots honor `ASHLR_WT_DIR`
and `ASHLR_RUNS_DIR`; size walks and git probes have shared two-second budgets.

## Merge queue age from a snapshot

Run `phm fleet merge-queue-age --input snapshot.json` for queued PR age and
blocking reasons, oldest first. Add `--json` for agents. The typed
`MergeQueueAgeInput` and `mergeQueueAge(input, now)` API use the same report.
The snapshot contains `prs` and `queue`; `--help` lists their fields.
Merged and closed PRs are excluded. Missing evidence stays unknown.

Each blocker in `causes` classifies with a `since` timestamp: pending,
failed and missing required checks take their own `at` (else the queue
entry's `enteredAt`); conflicts, review stalls and stale branches take the
PR's `updatedAt`. A stale branch is `mergeStateStatus` `BEHIND`; `DIRTY`
counts as a conflict just like `mergeable: CONFLICTING`. An unparseable or
future timestamp stays `null` — unknown, never guessed.

A conflicting active entry also lands in `retryable_conflicts` with the
`recut` request the existing merge-queue recut path enqueues once per head:
the shared `RQ-RECUT-<repo>-<pr>-<sha7>` idempotency key means a repeat
observation never enqueues a second recut. `blocked_conflicts` names the
honest reason nothing was enqueued — `ambiguous` queue or PR rows, `no-repo`,
`no-head`, `already-requested` (a `lastRecutHead` covering this head) or
`too-many-recuts` (three or more recorded `recutRequests`). Required checks
remain in place; this command only reads the supplied file and merges or
requeues nothing.

To prioritize conflict recovery by that same evidence, run `phm fleet
merge-recover --queue-input snapshot.json --json`. The report includes the
observation time, queue waits, and check blockers. Measured, unique entries are
processed oldest first; unknown or duplicate queue entries are not prioritized.
The snapshot is an observation, so the oldest reported PR is only the oldest
measured entry in that snapshot. Add `--apply` to queue recuts and, after a
replacement is published, request head-pinned GitHub auto-merge. GitHub still
enforces required checks and the merge queue. Retry the command after a failed
request or publication; it reuses the recovery identity.
Recovery rechecks the source before submitting work and reports work already
present on the base. Each source PR has three recut attempts and three auto-merge
attempts, persisted under `queue/merge-recover` in the runs directory. Failures
and interrupted submissions consume attempts; changing heads does not reset them.
`retry-limit` means that budget is exhausted. Preview reads the same budget
without spending it; an unreadable store prevents submission.

For a dropped auto-merge instead of a conflict, run `phm fleet merge-retry
--events merge-events.jsonl --json` against the same ledger `phm fleet
merge-latency` records into. The latency report's `queue_retries` classifies
each open PR's recorded auto-merge drop: `retryable` needs a `queue` blocker
in the enable-to-disable episode and retries left; `unattributed` drops wait
for a person. Dry-run prints `request-auto-merge`; `--apply` re-arms ordinary
head-pinned auto-merge (`gh pr merge --auto --match-head-commit`), appends one
`retry_requested` event per PR, and stops after three requests per run and
three retries per PR ever — replayed events count once. A failed submission
appends `retry_failed` instead; three distinct failed submissions make the
drop `request-failed` and stop automatic retries. Required checks,
reviews and the merge queue stay in force.

Acceptance: keep the interface as simple and intuitive as possible, with fewer
steps, plain words, one obvious path, and every human surface backed by a typed
API or CLI that agents can use (code-first, agent-native).

## Observed check, admission and merge delays

Run `phm fleet merge-latency --events merge-events.jsonl --hours 24 --json`.
The typed report's `queue_stage_timing` uses schema `fleet.queue-stage-timing.v1`
and is also returned by `GET /api/verse/fleet/merge-latency?hours=24`.
It compares merged PRs in the window; merges with unknown times remain included
as missing samples. Open PRs stay in the existing live diagnostics.
`required_checks` sums observed check-blocker intervals; queue entry alone
does not prove checks were pending. `queue_admission` measures readiness to
enqueue (zero when already queued); `merge` measures ready time inside the queue
until merge. Readiness requires an `eligible` observation. These are observed
intervals, not a complete partition of PR lifetime. Each stage reports measured
and missing counts, total seconds, median, p90 and maximum. `largest_delay`
selects the greatest observed total; ties, all-zero and unmeasured totals return
null. Missing, repeated, reversed or invalidated readiness boundaries stay
unmeasured. Required checks remain in place; the report grants no merge authority.

Acceptance: as simple and intuitive as possible, fewer steps, plain words, one
obvious path, with every human surface backed by a typed API or CLI for agents.

## Queue latency by stage and automatic recut

Run `phm fleet queue-latency --input snapshot.json` to see where PRs lose time
on the way to merge (waiting for approval, to join the queue, in the queue, or
running required checks) and which conflicts can be recut automatically. Add
`--json` for agents. The typed `QueueLatencyInput`, `queueLatency(input, now)`
and `formatQueueLatency(report)` API use the same report. The snapshot is
`{prs:[{repo,number,stages:[{stage,at}],headSha?,mergeable?,queuePosition?,recutRequests?,lastRecutHead?}]}`;
`--help` lists the stages. A conflicting PR with a known head, fewer than three
recuts and no recut for that head yet gets a `recut` recommendation with the
same idempotency key the recut loop uses; anything else is `needs_person`.
This only reads the supplied file; required checks stay in place and nothing
is merged or requeued.

`phm fleet queue-latency --live [--repos phantom,lexicon] [--json]` skips the
snapshot: it reads open PRs itself through the shared GitHub reader (default:
the seven ashlrai repos), runs the same attribution and ends with one line such
as `41 open PRs: 30 waiting on checks, 8 conflicting (8 recuts planned), 3 behind`.
Add `--recover` to preview recuts for conflicting `ashlrai/phantom` heads through
`phm fleet merge-recover` (dry run); `--recover --apply` queues them with
merge-recover's keyed, budget-bounded retries and its pinned
`gh pr merge --auto --match-head-commit` submit. Agents get the same data under
`live` in the `--json` report. Without `gh` installed and signed in, `--live`
exits 2 with a plain message.

Acceptance: as simple and intuitive as possible, fewer steps, plain words,
one obvious path, and every human surface backed by a typed API or CLI
that agents can use (code-first, agent-native).

## Repeated queue lines

Run `phm fleet queue-repeats --lines lines.json --json` for one number: how many
READY or CLAIMED lines from the last 24 hours repeat an earlier line with the
same repo, target file and acceptance, plus the top 5 examples. Omit `--json`
for plain words. Supply `QueueLine` records (`id`, `status`, `repo`, `at`,
`text`); the typed `queueRepeats(lines)` API returns the same report. Text must
name a target file before an `Acceptance:` clause, and lines without both are
never matched. Read-only. Gap: it matches exact normalized acceptance, not
reworded duplicates, and does not yet read `ready.tsv` directly.

## PR creation and queue delays

Run `phm fleet queue-age --events events.json --json` to rank PR delays from
creation to queue entry, queue entry to merge, and creation to merge. Omit
`--json` for plain words. Supply a JSON array of `QueueAgeEvent` records:
`{"pr":"ashlrai/phantom#42","event":"created","ts":"2026-01-01T00:00:00Z"}`.
Events are `created`, `queue_entered`, and `merged`; use repository-qualified
PR identities. The typed `queueAge(events)` API returns the same report.
This only reads the file. Exact duplicates are deduplicated; missing, reversed,
or repeated distinct boundaries (including re-entry) remain unmeasured.
The longest measured delays come first; ongoing waits are not estimated.

Acceptance: as simple and intuitive as possible, fewer steps, plain words,
one obvious path, and every human surface backed by a typed API or CLI
that agents can use (code-first, agent-native).

### Machine load

`phm fleet machine --json` and `GET /api/fleet/machine` expose the same
read-only `fleet.machine.v1` projection of dispatchd's `queue/status.json`.
Load per CPU uses the one-minute load average and CPU count; the Machine card
warns above four times the CPU count. Swap and free disk are in GB. Missing or
invalid measurements are `null` in JSON and shown as “unknown” in the card.
Worktrees are the dispatcher's active worker worktrees, not all Git worktrees.

### Fleet map

The Fleet screen shows a map of the Leader, reported lanes and active jobs.
Run `phm fleet map --minutes 60 --json` for the `fleet.map.v2` graph (replaces
the nested v1 tree). `GET /api/verse/fleet/control/map?minutes=60` serves the same
contract to the existing 2D/3D views with a current read session; minutes is 1..1440.
Every node and every edge carries a `provider` field: `Anthropic`, `OpenAI`,
`Cognition`, `xAI`, `Google`, `Z.ai`, `Cursor`, `Local` or `unknown`. A job's
provider comes from its model id, then its lane; an edge carries its sender's
(`from`) provider. One function decides this, `providerFor` in
`src/core/fleet/provider.ts`, and the 2D and 3D maps draw its badge on each
agent and message line. A name it does not recognise is `unknown` and shows a
neutral “?” badge, never a guess. Reporting edges point from child to parent.
Session evidence preserves exact lanes and stale jobs; missing model/provider/health
is `unknown`. The 2D map opens the existing job detail sheet. The 3D view retains
machine placement and reads shared job labels and message counts.
Message edges count retained, unexpired local bus receipts in the window, exclude
human/external messages, broadcasts to `leaders`, and bodies; unmatched peers are counted separately.
Each message edge also carries `lastAt`, the time of its newest message. This is
not a complete historical ledger. Leader, guardian and channel health remain unknown.

#### Org tree

`phm org` prints the same facts as one `fleet.org.v1` tree, and the Org pane
and the Fleet world's Org tab draw that tree top down: the leader, its
planners, each lane, each job under it.
JSON is the default; `phm org --text` prints it for people.
The map endpoint above carries the tree in its `tree` field.

The tree carries `version: 1`; it changes only when a field is removed or
changes meaning. Every node has `provider`, `model`, `state` (`running`,
`idle`, `held`, `done` or `unknown`) and `doing`, a plain sentence.

- `leader`: `label`, `status`, and the dispatcher's `lastTick` and `paused`.
  Its `state` and `doing` describe the dispatcher; the leader's own process,
  provider and model are not reported and stay `unknown` and `null`.
- `planners[]`: `executor` (Executor), `orchestrator` (Core orchestrator),
  `guardian` (Main guardian) and `comms` (Comms), always in that order, each
  with `label`, `role`, `state`, `doing` and `lastActivityAt`. Executor and
  orchestrator read the newest `LEADER` and `ORCH-*` dispatch events (the same
  attribution as `phm fleet brains`); guardian and comms read the newest agent
  message touching the guardian or a channel. A sign within 90 minutes is
  `running`, an older one `idle`, none in the short window read `unknown`.
  Optional: older servers do not send it.
- `lanes[]`: `lane`, `running`, `target`, `queued`, `held`, `heldReason` and
  `usage` (`usedPct`, `asOf`, `resetAt`). `model` is the model its jobs share,
  else the lane's newest launch. Fleet lanes come first in a fixed order, then
  any other lane by name.
- `lanes[].jobs[]`: `id`, `repo`, `tier`, `ageSeconds`, `goal` (the task
  title as one line; `null` for session rows, which never carry the prompt),
  `status`, `startedAt`, `lastEvent` (`at`,
  `kind`) and `lastActivityAt`. Oldest first. A job whose publish record has a
  `RESULT` line is `done` and is left out of its lane's `running` count, even
  when no exit code reached this computer (cloud jobs).
- `messages[]`: `from`, `to`, `count` for the message window, or `null` when
  the bus could not be read.

A fact no source reported is `null` in JSON and "unknown" in text and on
screen, never 0. Idle and held lanes are grey and say why on the row: the held
reason, "Turned off (0 seats)", or what is queued. A lane with no jobs reads "idle"; when no job source answered
(`jobsKnown` is false) it reads "jobs unknown" instead. The dot beside a job is
on when `lastActivityAt` is within the last 5 minutes. Selecting a job opens
its detail sheet.

#### Org groups

`phm fleet org [--json]` prints who reports to whom: the leader, then each lane,
then its jobs. `--json` is `fleet.org-groups.v1` and `GET
/api/verse/fleet/control/org-groups` serves the same tree to a current read
session. It groups the live map below and reads nothing else.

- `nodes[]`: `id`, `role` (`leader`, `group`, `lane`, `job`, `planner`), `label`, `parent`
  (null for the root), `children` (ids) and `counts` (`running`, `queued`,
  `idle`, `unknown`, summed over the leaves below). Parents come before children.
- Branches under the leader: one per lane, `Guardian` (`group:guardian`, the main
  guardian planner), `Loops` (`group:loops`: executor, Core orchestrator and comms)
  and `unassigned` for anything with no known parent. The guardian and loops
  branches come from the live map's `planners` and appear only when it has them;
  their counts stay out of the leader's and the headline, which count jobs.
  `phm org --json` adds this tree as `groups` (null when the live map could not be
  read) next to the `fleet.org.v1` fields; the Map's "Group: by lane | by org"
  toggle draws it, with the newest agent message on each parent link.
- `headline`: the one line a phone shows first: `running`, `queued`, `stuck` (running
  jobs with no activity in 5 minutes), `mergedLastHour` (null when no lane reported)
  and `text` ("6 running, 2 stuck, 14 merged in the last hour", or "Nothing running.").
- Lane nodes also carry `status`, `health` (the lane badge), `mergedPerHour` and
  `usedPct` (plan used, 0 to 100; null reads "Usage unknown"). Job nodes carry
  `status` and `live`. The phone Org layout draws exactly this and nothing more.
- A node with no known parent sits under the group `group:unassigned`. A repeated
  id keeps its first row and is listed in `duplicates`. Computers and pools are not
  part of the org.
- The Map pane's "Group: by lane | by org" toggle switches to this tree and remembers the choice.

#### Live map

`phm map` shows the whole fleet as one graph: the leader, lanes, running jobs,
computers and the pools lanes draw on. `phm map --json` prints it as
`fleet.live-map.v1`. `GET /api/verse/fleet/control/live-map` serves the same
graph to the desktop Map pane with a current read session. The graph adds no
source of its own. It joins the org map and tree above, `phm nodes` (computers
and the jobs each one holds) and the pool-usage ledger. A computer that is not
this one carries `remote: true`; the 2D map draws those together in an
"Other Macs" box, apart from this Mac.

`phm nodes pool [--json]` shows the joined Macs as one pool, this Mac first:
online, offline or unknown, free slots, running jobs, load, free memory and disk,
whether offload is on, when it was last seen, and a total such as "2 Macs, 11
free slots". `--json` is `phantom.nodes-pool.v1`, and
`GET /api/verse/fleet/control/nodes-pool` serves the same report to the
Machines card on the desktop and phone Home. Unknown facts say `unknown` and stay
out of the total (`total.slotsUnknown` counts online Macs whose slots were not
measured). The offload setting is per Mac; only this Mac's is known, so other
Macs show `unknown`.

`phm map --lane <lane> --repo <repo> --state <running|waiting|done|failed|unknown>`
narrows it to the agents (jobs) that match every filter given, with their lane,
computer and pool; `unknown` finds agents whose lane or repo nobody reported.
`--json` then adds `filter {lane, repo, state, matched, total}`, and each job node
carries `lane`, `repo` and `state`. A map with no match prints "No agents match
these filters." and exits 0. The desktop and phone Map views use the same
`filterLiveMap` (`src/core/fleet/map-filter.ts`), keep the choice for the
session and offer Clear. The map has no source for failed or waiting jobs yet,
so those filters find none until one reports; the `gaps` list says so.

- `orgLayout`: where the 3D map puts each org node, grouped by who it reports
  to (the tree `phm fleet org` prints; anything with no owner is under
  `unassigned`). `positions[]` has `id`, `role`, `label`, `parent`, `depth`, `x`,
  `y`, `z`; `labels[]` has one per lane and group with `text` such as
  `claude: 2 running`. The same input gives the same positions.
- `nodes[]`: `id`, `kind` (`leader`, `lane`, `job`, `computer`, `resource`),
  `level` (0 to 4, the row in the drawing), `label`, `provider`, `status`,
  `detail` and `live` (jobs only). Ids are stable: `leader`, `lane:<name>`,
  `job:<id>`, `computer:<name>`, `resource:<lane>`.
- `edges[]`: `id`, `kind` (`reports-to`, `runs-on`, `uses-resource`,
  `messaged-in-last-15-min`), `from`, `to`, `messages`, `lastMessageAt` and
  `pulse` (a message in the last minute).
- `counts`, `sources`, `unmappedMessages`, and `gaps`, which lists in plain
  words every fact the map could not show.

Every node and edge has the same keys in the same order, sorted by level and
id, so the same facts always print the same JSON. A job runs on a computer when
that computer's pool claim names it, or when a worker process for it was seen
on this computer. Messages to or from something not on the map, such as a
channel, are counted in `unmappedMessages` and never assigned to a node by
guessing. The server builds the graph at most once every 5 seconds, and the
pane polls no faster than that while it is visible. Selecting a node opens the
pane that already shows its details: the worker log for a job, Lanes, Computers,
Usage for a pool, or Leader. One 2D/3D toggle (remembered) shows the same graph
as rings stacked by org level, turning slowly until hovered and still under
reduced motion; phones always get the 2D rows. No 3D library is used.

#### Map edges

`phm map edges [--json] [--since 10m]` lists who messaged whom, read from the
same agent bus as `phm messages`. `--json` prints `fleet.map-edges.v1`
(`version` 1), and `GET /api/verse/fleet/control/map-edges[?since=10m]` serves
the same read with a current read session. The default window is the last 15
minutes, the same as the map.

`phm map replay [--json] [--since 6h] [--step 5m]` replays the fleet one frame
per step (default: the last 6 hours, every 5 minutes; at most 288 frames).
`--json` prints `fleet.map-replay.v1` (`version` 1) and
`GET /api/verse/fleet/control/map-replay[?since=6h&step=5m]` serves the same
read with a current read session. Each frame has `from`, `at`, `state`
(`known`, `partly-unknown` or `unknown`) and `running`, `launched`,
`prsOpened`, `merged`, `messages`, `lanes` (running jobs per lane) and `pools`
(`{pool, usedPct}`). The jobs come from the jobs ledger, read back 7 days (and
at most its last 32 MB) so a job launched long before the window still shows as
running; the messages are the `map edges` lines inside the frame. Pool used %
is the nearest reading in the usage history at or before the frame, and
`usedPct` is `null` (unknown) when none is within 30 minutes. A part nobody
recorded (ledger unreadable, or older than the bus keeps) is `null`, never an
empty list; `gaps` says why in plain words. Computers are shown as they are
now. The new fields are additions, so the schema stays `fleet.map-replay.v1`. The Map pane's time slider draws
these frames, with a "Back to live" button.

#### Recent bus messages

`phm bus recent [--since 5m] [--json]` lists agent-to-agent messages, newest
first, as `bus.recent.v1`: `{schema, as_of, messages:[{at, from, to, kind,
summary}]}`. `from` and `to` are routing labels and `summary` is one plain
line of at most 100 characters (the scrubbed summary, never the message
body). An empty bus prints "No messages yet."; `messages` is null when the bus
could not be read. The Fleet map pulses the same lines, and clicking a line
opens its messages.

#### Message graph

`phm fleet message-graph [--json] [--since 10m]` shows the same messages as
lines between organizations: the company behind each agent's lane, or
`unknown` when the agent's name proves no lane (the leader included). `--json`
prints `fleet.message-graph.v1` (`version` 1), and
`GET /api/fleet/message-graph[?since=10m]` serves the same read; the Fleet map
lists it under Messages.

| Field | Meaning |
| --- | --- |
| `groups[]` | One row per pair of organizations, newest first: `from`, `to`, `count`, `lastAt` and its `edges[]` (`from` agent, `to` agent, `count`, `lastAt`). |
| `organizations[]` | Each organization on a line: `name`, its `agents`, and messages `sent` and `received`. |
| `messages`, `since`, `source`, `skipped` | The same meaning as in map edges. |

Only names, counts and times are returned, never message text. When the bus
cannot be read, `groups` and `organizations` are `null` (unknown, not zero),
the CLI exits 1 and the route answers 503 with that same body. A bad `since`
or any other query is exit 2 or 400.

- `edges[]`, newest first: `id`, `from`, `to`, `count`, `lastAt` and
  `lastSummary` (the first 80 characters of the newest message, one scrubbed
  line).
- `from` and `to`: `name`, `role` (`leader`, `lane`, `worker` or `unknown`),
  `lane` and `node`, the id of that agent on `phm map` or `null` when the map
  does not draw it.
- `agents`: every name on an edge, grouped by role.
- `source`, `messages`, `skipped`, `since` and `generatedAt`.

When the bus cannot be read, `edges`, `agents` and `messages` are `null` and
the route answers 503 with that body: unknown, not zero. Notes to self,
broadcasts and messages from people are not edges, the same rule the map's
message lines use.

On the Map pane a message line is thicker the more messages it carried and
pulses for a minute after a new one. Selecting a line, or its row in the list
under the map, opens the Messages pane on the last 20 messages between those
two agents (`phm messages --agent <a> --with <b> --limit 20`). Agents that
talk but are not drawn are listed under the map with their role. The 3D
compute scene draws its message lines at the same thickness.

#### Agent conversations

`phm agents conversations [--agent <name>] [--waiting] [--json]` groups the
same bus read into threads by reply chain and by the declared conversation
label a body carries, longest-waiting first and then newest first. `--agent` matches a participant's routing label and, through
the agent identity registry, every other label of the same registered
identity (handle, alias or `agent:` address); with no readable registry the
match stays on the literal label. Messages about one v2 job — a `work.post`, its `work.status`,
`work.result`, `work.claim` and `work.release` bodies sharing a `jobId`, or a
claim-key-only body the post lists — form one `job:<id>` thread even without
replies, and a `failed` or `complete` outcome marks it blocked or done. Any
body carrying a declared label — the v2 `thread` field `--thread` reads
filter on (the same key `phm agents messages` reports as `threadId`), a
`threadId`, or a `job:<id>` key — buckets its conversation under that label
even without `replyTo` links, so a threaded question and its answer are one
conversation; only the synthesized per-pair fallback stays reply-chain
rooted. `group.presence` heartbeats are expiring observations with their own
read (`phm comms bus group presence`), never messages: they form no thread
and cannot answer a waiting one. `--json` prints `agents.conversations.v1` (`version` 1), and
`GET /api/verse/fleet/control/agent-conversations[?agent=claude&waiting=1]`
serves the same read with a current read session.

- `conversations[]`: `id`, `participants[]` (`name`, `label`, `known`, `node`;
  an agent no label proves has `label` "unknown agent"), `subject` (the latest,
  scrubbed), `messageCount`, `lastAt`, `state` (`waiting`, `answered`,
  `blocked` or `done`), `stateText`, `waiting` (`on`, `since`, `ms`; only while
  waiting for a reply), `links[]` (the pairs that talked) and `messages[]`.
- A reply to a message that is not on the bus starts its own thread. `null`
  conversations mean the bus could not be read, not that nothing was said.
- The Map pane draws a thicker line over each pair that talked in the last 10
  minutes, with a marker while a reply is awaited; selecting it opens the thread
  in the Conversations panel beside the map.

#### Agent messages

`phm agents messages [--since 1h] [--limit N] [--json]` lists recent
agent-to-agent messages from the same bus read (no new store), newest first.
`group.presence` heartbeats are observations, not messages, and never list.
`--json` prints `agents.messages.v1` (`version` 1), and
`GET /api/verse/fleet/control/agent-messages[?since=1h&limit=50]` serves the
same read with a current read session.

- `messages[]`: `at`, `from`, `to`, `kind`, `summary` (at most 160
  characters), `threadId` when the message names a thread, then `fromName` and
  `toName`. `from` and `to` are map node ids (`leader`, `lane:<name>`,
  `job:<id>`), or `unknown` when the map does not draw that agent.
- `pairs[]`: one per direction between two node ids over the whole window:
  `count`, `lastAt` and `recent` (the last 5 summaries).

On the Map pane, hovering a message line or its row shows a card with that
line's count and last 5 messages. The Messages switch above the map hides
every message line and the list. Reduced motion (the Settings motion choice or
the system setting) stops the pulse; lines keep their thickness.

### Live sessions

`phm sessions [--lane <lane>] [--repo <repo>] [--json] [--live]` shows every
agent session as one tree: the leader, then workers, then their subagents.
`--json` prints `fleet.live-sessions.v1`, and
`GET /api/verse/fleet/control/live-sessions[?lane=<lane>][&repo=<repo>][&live=1]`
serves the same document to the desktop Sessions pane with a current read
session. It projects the session map behind
`/api/verse/fleet/control/sessions` (the dispatch inventory joined with the
computers in `fleet.compute.v1`) and adds the `subagent.v1` records under
`~/.ashlr/subagents`.

- `tree`: a `fleet.session-tree.v1` document with `version`, `generatedAt`,
  `line` (for example "9 sessions running: leader, 6 workers, 2 subagents; 1
  failed in the last hour"), `counts` and `roots[]`. Each node has `id`,
  `parentId`, `agent`, `lane`, `model`, `repo`, `jobId`, `state` (`running`,
  `idle`, `done`, `failed` or `unknown`), `startedAt`, `lastMessageAt`,
  `lastMessage`, `kind` (`leader`, `worker`, `subagent` or `unknown-parent`),
  `lastMessageAgeSeconds`, `counts` (`below`, `running`, `failed`) and
  `children[]`. Siblings sort running first, then most recent. A session whose
  parent is not in the list sits under the `unknown parent` row. Finished
  sessions stay for an hour; `--live` (`live=1`) leaves them out.

  The leader's row comes from the leader's own files. Its `state` is `idle`
  (between passes) while the newest dated heading of its plan log is at most
  two hours old, and `unknown` otherwise: no record says whether an older
  leader is still alive. `lastMessage` is the newest reply it wrote you (the
  same source as `phm leader replies`), on one line and cut at 240
  characters, with `lastMessageAt` from that reply's heading. Its lane, model
  and start time are recorded nowhere and read `unknown` or null. When a pass
  or reply is on record and no lane or repo filter is set, the leader is
  listed even with no worker running. `gaps[]` names what the row could not
  show.

- `sessions[]`: `job`, `lane`, `model`, `repo`, `tier`, `status` (`launching`,
  `running`, `publishing`, or `unknown` for a job only another computer's claim
  names), `startedAt`, `ageSeconds`, `lastOutputAt` (the worker log's last
  write), `lastOutputAgeSeconds`, `quiet` (no output for more than 10 minutes;
  null when unknown), `prUrl`, `computer` (node id or `unknown`),
  `thisComputer` and `unknown`, which maps each unknown field to the reason.
- `counts` (`sessions`, `quiet`, `lanes`, `otherComputers`), `filter`, `live`
  and `gaps`.

Rows sort by lane order, then start time, then job id, with the same keys in
the same order. The server reads the session map at most once every 5 seconds.
Selecting a session in the pane opens the worker log, which has the existing
pause and stop controls.

### Session threads

`phm sessions threads [--lane <lane>] [--repo <repo>] [--live] [--json]` reads
every session as a short conversation, and
`GET /api/verse/fleet/control/session-threads[?lane=L][&repo=R][&live=1]`
serves the same `fleet.session-threads.v1` document with a current read
session. It is the read for a screen that shows every session at once: one
request instead of one [session thread](#session-thread) per session. It adds
no source. The session list, the agent bus, the Leader inbox and the leader's
replies are read once, and the recorded activity once for each job shown.

- `filter`: `lane`, `repo` (null when not set) and `live` (true when only
  running sessions were asked for). They work as they do for the session list.
- `counts`: `sessions` (every session in the list), `shown` (the ones in
  `threads`) and `states`, a count of the shown sessions under each of
  `running`, `quiet`, `idle`, `done`, `failed` and `unknown`.
- `threads[]` in the order of the session tree: the leader, then each worker
  followed by its helpers. At most 40. Each has `session` and `summary[]`
  exactly as the session thread gives them, `messages[]` (the newest 3
  messages of that thread, oldest of them first, each with the session thread's
  fields plus `truncated`, true when `text` was cut at 400 characters),
  `messageCount` (how many messages the whole thread holds), that thread's
  own `sources` and `gaps[]`, and `reply` (`to`, `mention`, `hint`): where
  words written to that session go, the same answer the session thread gives.
- What Mason wrote is part of each thread, as in the session thread: the
  leader's holds every Leader inbox message, a worker's the ones naming it as
  `@<job>` (kind `owner`), and a helper's none. A worker's summary says how
  many were aimed at it.
- Where the Leader routed a message is part of each thread too, from the same
  order trace as the session thread: a `routing` record follows each routed
  message in the leader's thread, and a worker with a job opens with the
  message it serves (kind `order`) and says so in its summary. Helpers get
  none. The trace is read once for the whole document.
- What a running session wrote is part of its thread: an `output` message
  with the last 3 lines of its log (the newest 400 characters of them when
  they are longer, `truncated` true when anything was left out). Only running
  sessions have their log read here; a finished one's thread ends with its
  outcome, and its single thread still shows its output.
- `sources`: `sessions` (`available` or `unavailable`), and `bus`, `owner`,
  `replies` and `orders` (`available`, `none` when the read answered and no
  shown session has any, or `unavailable`). `gaps[]` holds the session list's
  own gaps, a line counting the sessions left out past 40, and a failed bus,
  inbox or order trace read.

Each read fails on its own: a job whose activity could not be read says so in
its own `gaps` and the other threads are whole. The route answers 503 when the
session list cannot be read, so an unreadable list never looks like a fleet
with no sessions, and 400 for anything but `lane`, `repo` and `live=1`, once
each. One build per filter serves every caller for 5 seconds. The CLI exits 1
when the list cannot be read; with `--json` it still prints the document, with
`sources.sessions` `unavailable` and no threads. Text is scrubbed the same way
as the session list.

### Session thread

`phm sessions thread <id> [--json]` reads one session as a conversation, and
`GET /api/verse/fleet/control/session-thread?id=<id>` serves the same
`fleet.session-thread.v1` document with a current read session. The id is
`leader`, a job id or a subagent id from the session tree. It adds no source:
it joins the session's row in `fleet.live-sessions.v1`, the job's
`fleet.job.activity.v1`, the agent bus messages (`phm agents messages`), the
messages Mason wrote in the Leader inbox and, for the leader,
`leader.replies.v1`.

- `session`: `id`, `kind`, `agent`, `lane`, `model`, `repo`, `jobId`,
  `parentId` (null for the leader), `state` (`quiet` for a running session
  with no output for 10 minutes, otherwise the tree's state), `startedAt`,
  `ageSeconds`, `lastMessageAt`, `lastMessageAgeSeconds`, `prUrl`, `computer`
  and `helpers` (`below`, `running`, `failed`).
- `summary[]`: short sentences assembled from those records: what it is and
  where, its state and when it last spoke, its helpers, its pull request,
  commands seen and files changed, and its latest recorded step. No model
  writes it, and a fact no record holds reads "unknown".
- `messages[]` in reading order: the brief it was given, each recorded step,
  the last 8 commands, up to 6 changed files, its notes, the newest 50 bus
  messages that name its job or were sent by or to it, the newest 10 messages
  from Mason, the leader's last 5 replies (leader only), the last 12 lines
  it wrote to its log, then its last
  message. Each has `key`, `kind`
  (`order`, `routing`, `brief`, `step`, `commands`, `files`, `notes`, `bus`,
  `owner`, `reply`, `control`, `output`, `latest`),
  `side` (`session` when it speaks, `other` when someone speaks to it,
  `record` for a recorded step), `label`, `at` (null when the record has no
  time), `text` and `format` (`plain`, `mono` or `markdown`).
- What the session wrote (`output`) is the end of its job log, read for a
  session with a job through the same bounded, no-follow read as
  `phm sessions tail`, every line redacted. Blank lines are dropped, the
  newest 12 are kept and a line is cut at 240 characters. The log has no time
  per line, so `at` is null, and the label says whether earlier lines exist
  ("last 12 lines of its log") and whether the log is archived. When the
  output already ends with the session's last message, `latest` is left out
  instead of being said twice. `sources.output` is `none` for a session that
  wrote nothing (or has no job) and `unavailable`, with a line in `gaps`,
  when the log could not be read.
- Messages from Mason (`owner`) come from the Leader inbox, the newest 200
  entries of it. The leader's thread holds every one. A worker's thread holds
  the ones that name it as `@<job id>`, which is what the desktop reply boxes
  write. The inbox belongs to the leader, so the label reads "Mason to the
  Leader, aimed at <job>": the message is on record there, and no record says
  the worker read it. A helper's thread holds none. The inbox keeps Eastern
  time to the minute, so `at` is that minute as ISO. In the leader's thread
  these messages and the replies are put in time order when every one of them
  has a time; otherwise Mason's come first, then the replies.
- Routing (`order`, `routing`) comes from the order trace behind
  `GET /api/verse/leader/orders`, which ties a job to one of Mason's messages
  when the job's prompt cites that message's time. A worker's thread opens
  with the message it serves (`order`, the newest 3), labelled "Mason to the
  Leader, served by <job>", followed by a `routing` record when other jobs
  serve the same message. In the leader's thread a `routing` record follows
  each of Mason's messages that has jobs. A routing record has one line per
  job, up to 8: the job id, its lane or "lane unknown", the trace's state
  (`queued`, `launched`, `published`, `merged`) and the pull request link
  when there is one. A message no job cites gets no record, and a session no
  message is tied to gets no `order`: nothing is guessed from timing. When
  the served message is outside the inbox entries read, the `order` names
  its time and says its text was not read. The server reads the trace at
  most once every 15 seconds.
- Control requests (`control`) come from the job control file that
  `phm job pause|resume|stop|move` and
  `POST /api/verse/fleet/runs/control` write. A thread for a session with a
  job shows the newest 5 requests for that job, before its output, each as a
  record: the label says what was asked and what became of it ("Pause
  requested", "Paused", "Move to codex refused"), `at` is when it was
  recorded, and the text names the surface that asked (`cli`, `desktop`,
  `mobile`) and either that the dispatcher has not applied it yet, that it
  is done, or the refusal's reason. A request reads as applied only when
  the file holds that answer. `sources.controls` is `none` when the file
  holds nothing for the job and `unavailable`, with a line in `gaps`, when
  it could not be read.
- `sources`: `sessions` (`available` or `unavailable`) and `activity`, `bus`,
  `owner`, `replies`, `orders`, `output`, `controls` (`available`, `none` when the read answered with nothing for this
  session, or `unavailable`). `gaps[]` says in plain words what is missing.
- `reply`: where a message written to this session goes, so every client
  aims it the same way. `to` is `leader` (the Leader inbox as it is), `job`
  (the Leader inbox with `mention`, `@<job id>`, in front) or `none`.
  `mention` is null unless `to` is `job`. `hint` is one sentence saying
  where the message goes or why none can be sent. Only a running or quiet
  worker whose job id fits the `@RQ-...` mention syntax gets `job`; a
  finished session, a helper without a job and an unknown id get `none`. No
  route writes to a worker directly: the inbox belongs to the leader, and
  the write is `POST /api/verse/leader/inbox`.
- `control`: the request that stands for the session's job, which is the
  newest one not refused: `action` (`pause`, `resume`, `stop`, `move`),
  `lane` (the target of a move, otherwise null), `status` (`requested` or
  `applied`) and `at`. Null when none stands or the file was not read. The
  summary says the same in one line. A client uses it to offer Resume in
  place of Pause.

Each read fails on its own, so a thread with an unreadable bus still shows the
rest. The route answers 404 for an id the list does not hold (finished
sessions leave after an hour), 503 when the session list cannot be read, and
400 for anything but one `id`. The CLI exits 2 for an unknown id and 1 when
the list cannot be read. Text is scrubbed the same way as the session list.

### Desktop workbench actions (WB-4)

`POST /api/wb/v1/action` requires dispatch enabled, the existing mutation
capability in `x-ashlr-token`, and `Content-Type: application/json`. Read tokens
and browser read sessions cannot authorize actions. The server stores its
existing capability at `~/.ashlr/wb/token` with mode 0600; it creates no additional
capability. Treat this file as private local custody.

Bodies contain `action`, a unique 32–64 lowercase hexadecimal `nonce`, and
optional `dryRun` (defaults to true). Lane actions `lane.pause`, `lane.resume`,
`lane.target` require `lane`; target also requires an integer `target`. Resume
restores the remembered pre-pause target. Queue actions `queue.hold`,
`queue.unhold`, `job.retry` require `job`. Holds affect only READY jobs; retries
create a new attempt only for a finished failed job. `reap.count` takes no target
and only counts reclaimable worktrees. Extra fields are refused.

Steer actions drive the Verse steer pane. `steer.note` requires `text` and
appends it to the Leader inbox under the "Phantom workbench" source (empty,
overlong and secret-shaped text is refused before anything is written).
`queue.reprioritize` requires `job` and `priority` (`P0`–`P3`) and moves only
READY or HOLD lines; claimed or finished jobs are refused. `job.stop` requires
`job` and ends a running job: SIGTERM, then SIGKILL after the grace period, with
the same stop ledger and event narration as the operator stop path. The CLI
twins `phm wb steer --text <note>`, `phm wb reprioritize <job> --priority <P0-P3>`
and `phm wb stop <job>` share the action implementation; they are dry runs
unless `--apply` is given and print the same result with `--json`.

`GET /api/wb/v1/steer` is the pane's composite read. It reports the fleet.v1
roster slice (claim IDs reduced to present/absent, leases never projected), the
public seats, and the queue lines (id, status, priority, pool, tier, bounded
scope). Each source carries a state field (`ok`, `missing`, `not-fleet-v1`,
`unavailable`) so the pane can show an honest empty state instead of a fake
healthy roster.

Nonces are consumed for dry runs and failed attempts as well as successful
applies, and survive server restarts. Use a fresh nonce to apply a reviewed dry
run. `~/.ashlr/wb/audit.jsonl` records timestamps, fixed action names and outcomes;
request values, capabilities, job IDs, paths and nonces are never recorded.
