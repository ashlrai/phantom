# Demonstrate cross-receiver durable dedupe and acknowledgement

From the repository root, run a fully local demo that delivers one fixed fake
message through a desktop receiver and replays it through a fresh Telegram
receiver, proving durable cross-receiver dedupe:

```sh
npx tsx examples/agents/channel-ack-replay.ts
```

This demo takes no flags; it creates a private temporary runsDir (removed on
every exit path) and uses a fixed fake sender and body.

The single JSON line on stdout has `schema` (`"phantom.channel-ack-replay.v1"`),
`verified` (boolean), `runsDir` (path string), `receipts` (an array of two
acknowledgement objects, each with `status` and `dedupeKey`), `acknowledgements`
(an array showing each ack's `channel` and `status`), `sameDedupeKey` (boolean),
`inboxEntries` (count), and `entrySource` (string or `null`).  Exit codes:
`0` verified, `1` failure or mismatch, `2` usage error (extra arguments),
`3` evidence unavailable.
