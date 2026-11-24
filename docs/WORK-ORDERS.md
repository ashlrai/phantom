# Work-order proposals

`normalizeWorkOrder` accepts a structured work-order proposal with `id`, `type`,
`repo` (owner/name), `task`, `acceptance`, and `replyChannel`. Types are `review`,
`analysis`, `second-opinion`, and `implementation`; reply channels are
`imessage`, `slack`, and `bus`. Secret-shaped task and acceptance text is refused.
`planWorkOrder` assigns reasoning work to `dot` and implementation to `fleet`.
Both functions are local, proposal-only, and perform no I/O.

This is not an operational bridge. Teammate iMessage bodies remain local and
Slack ingress remains untrusted; neither source grants execution or send
authority. Result capture, durable dispatch, reply delivery, and proactive
scheduling require a separately reviewed integration with the existing channel
and execution policies.

## Reply state

Before any fleet reply about a work item, read its state once:
`phm channels reply-state <request-id> --json` (schema
`phantom.channels.reply-state.v1`). The answer is exactly one of RECEIVED,
ASSIGNED (named owner plus a durable claim id), RUNNING (live claim evidence),
BLOCKED (the missing dependency) or VERIFIED (PR and head, or test result), with
an as-of time and its source. It comes from the bus inbox and claim records,
never from message text; with no record it says RECEIVED, no owner yet. A repeat
request in the same Slack thread resolves to the first request's id, so replies
stay in one thread per work item. The `text` field is what to post: `STATE (as of HH:MM UTC, source: <file or route>)` and one line of evidence. `phm work state <id> [--json]` is the same read.
