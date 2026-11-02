# Steer the leaders

Send one message to the leader agents. The app's steer box, the Steer and Hand
off buttons on each node of the fleet graph, and the CLI all use the same path:
Mason's inbox through the shared channel receiver, which also mirrors the
message onto the agent bus (`phm comms bus read`).

## Copy and paste

```sh
phm app steer --text "Pause new PRs on phantom until CI is green" --json
```

Output is one JSON object:

| Result | Exit | stdout JSON |
| --- | --- | --- |
| sent or duplicate | 0 | `{ok:true,status:"accepted"\|"duplicate",channel:"cli",dedupeKey,at,publish}` |
| refused | 1 | `{ok:false,reason:...}` (`empty`, `too-long`, or a receiver reason) |
| invalid arguments | 2 | `{ok:false,reason:"invalid"}` |

The same text sent twice within ten minutes is reported as `duplicate` and is
written once. Messages are scrubbed for secret shapes before they are stored.
Maximum 6000 characters.

## What it is and is not

- Only the local process owner (the CLI) or the authenticated app session can
  steer. Identity is fixed by the adapter, never read from the message text.
  Telegram, email and phone messages reach the same inbox through their own
  authenticated bridges (see [CHANNELS.md](CHANNELS.md)); the app only exposes
  this steer API and adds no channel of its own.
- On a graph node, Steer and Hand off open the steer box with a prepared line.
  Readings are quoted as the row shows them: a usage number, or `unknown`.
  A missing reading is never turned into a percentage.
- Answering plain-English questions from a `fleet.mission.v1` snapshot is not
  built: that schema does not exist in this repository yet. Questions are
  delivered to the leaders like any other message.
