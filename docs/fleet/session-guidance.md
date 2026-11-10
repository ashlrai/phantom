# Per-session guidance (RQ-PHX-SESSIONINTERJECT)

The ability to observe, communicate and interject to adjust the direction of
every running agent session. Today the interject box and `phm app steer` land
in the leader inbox or on the agent bus: nothing reaches the running CLI agent
of a specific job. This change adds a per-job guidance channel.

## What Phantom does

`POST /api/fleet/sessions/<job>/guidance` with a JSON body `{"text": "..."}`
appends one message to `~/.ashlr-runs/queue/guidance/<job>.jsonl`. The route
sits behind the same gate as the steer and interject boxes: it does not exist
unless the server runs with dispatch enabled, and every write needs the
mutation token in `X-Ashlr-Token` plus `Content-Type: application/json`.
`GET` on the same path reads the file back through the ack fold, and
`GET /api/fleet/guidance` answers the aggregate state every console row polls.

The writer guarantees:

- append-only JSONL, one record per line, directory mode `0700`, file mode
  `0600` (the umask-077 posture);
- job ids are validated before a path is built (`^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$`,
  no `..`), so a job id can never escape the guidance directory;
- text is run through the secret scrubber before it is serialized, and the
  serialized line is scrubbed once more, so no field can carry a secret into
  the file;
- one message is capped at 4 KiB of UTF-8 (truncated messages are marked
  `truncated: true`);
- `O_NOFOLLOW`, single-link, owner-checked targets: a symlinked or foreign
  guidance file is refused, never followed.

Phantom writes ONLY this file. `jobs.jsonl` history is never written.

## File contract

`queue/guidance/<job>.jsonl`, one JSON object per line:

```json
{"v":1,"type":"guidance","id":"g-…","job":"RQ-…","at":"…","source":"fleet-console","lane":"claude","tier":"work","strategy":"resume-followup","text":"…","truncated":false}
{"v":1,"type":"ack","id":"g-…","at":"…","state":"delivered","turn":4}
{"v":1,"type":"ack","id":"g-…","at":"…","state":"requeued","to":"RQ-…-2"}
```

A message starts `queued`. The first valid ack moves it to `delivered`
(carrying the agent turn it landed on) or `requeued` (carrying the replacement
job id). Both are terminal; later acks are refused by the state machine and
counted as `invalidAcks`, never applied.

## Per-lane delivery strategy

`src/core/fleet/session-guidance.ts` holds the strategy table. Lane names are
data, not a hardcoded enum: exact lanes and lane prefixes resolve to an engine
family, and anything the table does not know falls back to requeue.

| Lane family | Delivery |
| --- | --- |
| `agy` (incl. `agy-*`) | `--input-format stream-json`: inject as the next NDJSON user message on stdin; `--conversation resume` after a stop |
| `claude`, `claude-api`, `zai` (incl. `claude-*`) | `--resume <session>` with the guidance as the follow-up prompt at the next turn boundary |
| `codex-*` | `codex resume` with the guidance prepended to the working prompt |
| `grok` (incl. `grok-*`) | `--resume`/`--session-id` with the guidance prepended |
| `devin`, `local`, unknown | requeue with guidance: stop at the next safe point, prepend the text to the job prompt, requeue same lane/tier |

## Security proposal: the consumer side (NOT in this change)

`dispatchd` and `launch.sh` are pinned and are not edited here. The proposal
for Security review:

1. `dispatchd` watches `queue/guidance/<job>.jsonl` (or polls it on its normal
   tick) for entries it has not acked.
2. For lanes whose strategy is `stream-json-inject`, the launcher writes the
   guidance line to the agent's stdin as the next NDJSON user message and
   appends `{"type":"ack","state":"delivered","turn":N}` with the turn the
   message landed on.
3. For `resume`/`resume-followup` lanes, the launcher stops the agent at the
   next turn boundary, resumes the session with the guidance as the follow-up
   prompt, and appends the same delivered ack.
4. For `requeue` lanes (devin, local, anything unknown), `dispatchd` stops the
   job at the next safe point, prepends the guidance text to the job prompt,
   requeues on the same lane and tier, and appends
   `{"type":"ack","state":"requeued","to":"<new-job>"}`.
5. Consumers only ever append `type:"ack"` lines; they never rewrite or
   truncate the file, and they keep the 0600 mode.
6. Consumer reads pass every line through the same secret scrubber before
   the text is shown to any agent or log.

Until a consumer lands, messages stay `queued` and the console shows them as
such; the write path is complete and test-covered on its own.

## Console

Each row of the fleet Working card (`WorkersCard`, the live running-session
surface) carries a Guide control that expands a `SessionGuidanceBox`: the lane
strategy label and mechanism, a 4 KB text box, and the ack state of the last
message (queued, delivered at turn N, or requeued as job X). The aggregate
read polls every 5 s alongside the worker list. Guidance for a lane the
strategy table does not know still lands: the row chip reads requeue and the
message is held for the fallback consumer.
