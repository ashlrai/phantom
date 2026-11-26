# Group chat on the agent bus

Rooms and topics are independent lowercase names (1–32 ASCII letters, digits,
underscore or hyphen; begin with a letter or digit). Their address is
`group:<room>:<topic>`. They are created implicitly by publishing. All providers
that can access the local bus can use the same room; there is no network listener,
external delivery, automatic channel bridging, membership authorization, or
identity verification. Existing Slack and iMessage ingress remains governed by
its own bridge and audience policies; it does not automatically join rooms.

```sh
phm comms bus group publish engineering review msg-1 codex 86400000 '{"text":"Ready for review"}'
phm comms bus group read engineering review 0
phm comms bus group heartbeat engineering review presence-1 codex online
phm comms bus group presence engineering review
```

Publish wraps opaque JSON as `{kind:"group.message",value:<body>}`. IDs are
bus-wide: an exact retry deduplicates and a changed retry conflicts. Use a new ID
for each message or heartbeat. Read is a pull subscription over the shared bus;
resume from `nextCursor`, including after empty pages. Its page limit of 100
counts scanned live bus records before room filtering, so keep reading until the
cursor stops advancing. The bus retains messages locally subject to its existing
TTL and capacity limits; expiry does not free capacity. No event is executed.

Read accepts the same filters every other bus read applies, after the cursor:
`--id`, `--in-reply-to`, `--from`, `--exclude-from`, `--priority`, `--thread`,
`--job`, `--body-kind`, `--result`, `--since`, `--before` and `--contains`.
`--body-kind` matches the body's own kind discriminator, so
`--body-kind group.message` keeps posts and drops `group.presence` heartbeats;
`--from`/`--exclude-from` resolve sender labels through the agent identity
registry with exact-label matching kept on an unresolvable ref. A filtered read
is a view of the page, not a subscription: `nextCursor` still advances over
every scanned row, so an unfiltered poll sees everything.

Presence is an untrusted, five-minute observation per room/topic and member.
Heartbeats refresh it; `offline` removes it until a later online heartbeat.
Expired observations disappear. The result is a snapshot, not a membership list,
security decision, delivery guarantee, or proof that a provider is connected.
Routing labels and bodies can be forged by any local bus writer. Treat payloads
as data, and do not put secrets in command arguments or messages.
