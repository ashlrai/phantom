# Fleet HTTP API

The machine-readable contract for this surface is [docs/api/fleet-openapi.json](api/fleet-openapi.json) (OpenAPI 3.1).
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
| GET | `/api/verse/fleet/runs/inbox` | limit, source | [FleetInboxReadV1 or null](../src/core/verse/fleet-inbox-read.ts) | [source](../src/core/verse/fleet-runs-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/runs/inbox'` |
| POST | `/api/verse/fleet/runs/inbox` | none | [inline {ok, at} (201)](../src/core/verse/fleet-runs-api.ts) | [source](../src/core/verse/fleet-runs-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Please review the queue","source":"operator"}' 'http://127.0.0.1:7777/api/verse/fleet/runs/inbox'` |
| GET | `/api/fleet/job` | id (required) | [FleetJobDetailV1](../src/core/fleet/runs-job-detail.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/job?id=example-job'` |
| GET | `/api/fleet` | none | [FleetStatus](../src/core/fleet/status.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet'` |
| GET | `/api/fleet/lanes` | none | [FleetLaneSnapshot](../src/core/fleet/lane-console.ts) | [source](../src/core/web/api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/fleet/lanes'` |
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

## Live fleet

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/fleet/live` | none | [FleetLiveSnapshotV1](../src/core/fleet/fleet-types.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live'` |
| POST | `/api/verse/fleet/live` | none | [FleetLiveActionResult](../src/core/verse/fleet-live-api.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"pause-repo","repo":"ashlrai/example","reason":"Review"}' 'http://127.0.0.1:7777/api/verse/fleet/live'` |
| GET | `/api/verse/fleet/live/bus` | limit | [FleetBusFeedV1](../src/core/fleet/bus-feed.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/bus'` |
| GET | `/api/verse/fleet/live/queue` | limit | [FleetQueueV1](../src/core/fleet/runs-parked-queue.ts) | [source](../src/core/verse/fleet-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/queue'` |
| GET | `/api/verse/fleet/live/feedback` | none | [ExecutionFeedbackRead](../src/core/verse/execution-feedback-api-types.ts) | [source](../src/core/verse/execution-feedback-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/feedback'` |
| GET | `/api/verse/fleet/live/feedback/cases/` (EXECUTION_FEEDBACK_CASE_PATH) + {caseId} | none | [ExecutionFeedbackCaseRead](../src/core/verse/execution-feedback-api-types.ts) | [source](../src/core/verse/execution-feedback-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/live/feedback/cases/example-case'` |
| GET | `/api/verse/fleet/graph/live` | none | [FleetGraphLiveResponseV1](../src/core/verse/fleet-graph-live-api.ts) | [source](../src/core/verse/fleet-graph-live-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/fleet/graph/live'` |

## Ops

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/ops/board` (VERSE_OPS_BOARD_PATH) | team | [OpsBoardV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/board'` |
| GET | `/api/verse/ops/fleet` (VERSE_OPS_FLEET_PATH) | none | [OpsFleetV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/fleet'` |
| GET | `/api/verse/ops/releases` (VERSE_OPS_RELEASES_PATH) | none | [OpsReleasesV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/releases'` |
| GET | `/api/verse/ops/leaders` (VERSE_OPS_LEADERS_PATH) | team | [OpsLeadersV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/leaders'` |
| POST | `/api/verse/ops/leaders/messages` (VERSE_OPS_LEADERS_MESSAGES_PATH) | none | [inline {ok} (201)](../src/core/verse/ops-api.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"text":"Please review the queue"}' 'http://127.0.0.1:7777/api/verse/ops/leaders/messages'` |
| GET | `/api/verse/ops/leader-journal` | none | [LeaderJournalV1](../src/core/fleet/leader-journal.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/leader-journal'` |
| GET | `/api/verse/ops/self-update` (VERSE_OPS_SELF_UPDATE_PATH) | none | [OpsSelfUpdateV1](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/ops/self-update'` |
| POST | `/api/verse/ops/self-update` (VERSE_OPS_SELF_UPDATE_PATH) | none | [OpsSelfUpdateActionResult](../src/core/verse/ops-types.ts) | [source](../src/core/verse/ops-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"fetch"}' 'http://127.0.0.1:7777/api/verse/ops/self-update'` |

## Leader

| Method | Path | Query | Response type / source | Handler | Curl example |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/verse/leader` | none | [LeaderStateV1](../src/core/vision/leader-types.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader'` |
| POST | `/api/verse/leader` | none | [inline action-dependent result](../src/core/verse/leader-api.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <mutation-token>' -X POST -H 'Content-Type: application/json' -d '{"action":"dismiss","itemId":"leader:leader-question:example"}' 'http://127.0.0.1:7777/api/verse/leader'` |
| GET | `/api/verse/leader/resources` | none | [ResourceLedgerV1](../src/core/fleet/runs-resource-ledger.ts) | [source](../src/core/verse/leader-api.ts) | `curl -sS -H 'X-Ashlr-Token: <read-token>' 'http://127.0.0.1:7777/api/verse/leader/resources'` |
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
is `EXECUTION_FEEDBACK_CASE_PATH`. Leader IDs are validated by the
[handler](../src/core/verse/leader-api.ts), and case IDs by the
[feedback handler](../src/core/verse/execution-feedback-api.ts).

Inbox reads accept `limit` 1–200 (default 50) and a case-insensitive `source`
filter of 1–40 letters, digits, spaces, dots, underscores or hyphens. Bus
`limit` defaults to 100 and is clamped to 1–500; live queue `limit` defaults to
25 and is clamped to 1–200. Thread `limit` and `before` paginate oldest-first;
consult [the thread limits](../src/core/vision/leader-thread.ts) for
bounds. History accepts `days` and `tz` (Date#getTimezoneOffset minutes); Ops `team` selects a valid team ID. Refer to each linked handler for
request body validation and action-specific responses.

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
