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
