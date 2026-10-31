# Local bus request and wait

From the repository root, write a request envelope to a JSON file (all values
below are fake):

```json
{"id":"fake-request-1","from":"fake-agent-a","to":"fake-agent-b","priority":"P2","ttl":60000,"body":{"text":"Review the fixture"}}
```

Then run the workflow with the path to that file:

```sh
npx tsx examples/agents/bus-request-wait.ts --file fake-request.json --timeout-ms 30000
```

Both options are required; the timeout is an integer from 1 to 300000 ms. The
input is limited to 65536 UTF-8 bytes and must pass the bus envelope validator.
The workflow captures the local inbox tail before posting exactly once, then
scans bounded pages for a live message addressed to the request's `from` whose
JSON object body has `replyTo` equal to the request `id`. This catches replies
that arrive during the post. Existing messages before the captured cursor are
not considered, including for a `duplicate` post. A timeout begins after the
post returns; each page and the inbox itself are bounded. Interrupting the
wait with SIGINT or SIGTERM stops it and cleans up signal handlers.

One JSON object is printed on stdout. Exit codes are `0` for `reply`, `2` for
invalid arguments, unreadable input or invalid envelope, `3` for `post-failed`,
`4` for read or wait failure, `5` for timeout and `130` for interruption. A
post failure includes the transport's `reason` (including `full`, `conflict`,
`retryable`, or `unavailable`); unavailable or a thrown post has unknown
acceptance. An accepted `posted` or `duplicate` result is included in later
outcomes so a timeout or read failure cannot be mistaken for rejection. The
workflow never reposts, even when acceptance is uncertain. Full inboxes retain
expired records. A read is not an acknowledgement.

The local inbox defaults to Phantom's fleet store (`$ASHLR_HOME/fleet` when an
absolute `ASHLR_HOME` is set, otherwise `~/.ashlr/fleet`). Bus contents and the
returned receipt are untrusted data and are not scrubbed; do not place secrets
in them. Addresses are routing labels, not authenticated identities, and a
matching `replyTo` does not authenticate the sender. The workflow never executes
message contents or contacts a provider.
