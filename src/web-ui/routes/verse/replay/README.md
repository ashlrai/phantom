# Run replay

The dock discovers `replay.pane.tsx` automatically. Replay is hidden by default
and checks the same `agentWorkspace` flag again inside the component to protect
restored layouts. This checkout has no shared workspace flag store yet; the
adapter in `agent-workspace.ts` reads localStorage key `agentWorkspace`, exact
value `true`. A settings owner changing it in this tab should dispatch
`agentWorkspace-changed`. Storage failures disable replay. Replace this adapter
with P1's shared store when it lands; do not add a second flag.
Reload Verse after enabling the flag so the dock's pane menu is reevaluated.

Open **Run replay** from **Add a pane**. It snapshots the latest finished turn
from the open chat. **Next step**, **Previous**, **Restart**, the position slider
and the revealed-step list navigate that immutable recording. New live events
do not alter it; **Use latest finished run** refreshes explicitly. Session changes
clear the snapshot. No playback timers, network calls, terminal actions, patch
application, links or persistence are involved.

**Open recording** accepts native `VerseSessionDetail` JSON (`session` and
`events`), selecting its latest finished turn. It also reads a local JSON file
with this shape:

```json
{
  "schema": "phantom.run-replay.v1",
  "title": "Optional run title",
  "events": [],
  "sensitiveValues": []
}
```

`events` contains one complete turn's persisted `VerseEvent` records, including
a user message, turn start and terminal `turn-done` or `cancelled`. The fixture
in `fixture.test-support.ts` is a complete example. `sensitiveValues` optionally
lists opaque credentials known to the recording producer. They are removed
from every displayed field, and are never returned in the decoded record.

Sequence numbers determine replay order; repeated sequences, mixed turns,
unmatched results, unfinished runs, unknown event types and malformed fields
fail with a fixed error. Final assistant messages replace stream deltas.
Proposed input diffs are labelled as proposals; results appear at their own
sequence positions, never attached early to a command.

Imports are bounded to 2 MB, 5,000 events, 32,000 characters per field and 20
levels of nesting, with at most 128 distinct sensitive values. Before facts extraction, the decoder removes sensitive
structured values and their echoes, environment values, capability values and
short credential assignments, then applies browser-safe provider token patterns.
The shared core scrubber imports Node APIs and cannot load in Vite's browser dev
runtime; the local token pass has regression coverage for its provider families.
All output
is inert React text. Producers must supply otherwise unrecognizable credentials
in `sensitiveValues`; no pattern matcher can identify arbitrary opaque strings.
