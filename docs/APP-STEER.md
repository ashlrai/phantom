# Steer the leaders

Send one message through the shared inbox receiver using the app's steer box,
the fleet graph's Steer and Hand off buttons, or the CLI:

```sh
phm app steer --text "Pause new PRs on phantom until CI is green" --json
```

The CLI uses its local operator identity; message text cannot change it.
Messages are scrubbed for secret shapes before storage. The maximum is 6000
characters. Repeating the same text within ten minutes returns `duplicate`.

| Result | Exit | Output with `--json` |
| --- | --- | --- |
| Accepted or duplicate | 0 | `{ok:true,status:"accepted"\|"duplicate",channel:"cli",dedupeKey,at,publish}` |
| Refused | 1 | `{ok:false,reason:...}` |
| Invalid arguments | 2 | Usage on stderr; no message is submitted |

## Aim with @ in the Leader reply box

In the Leader pane (⌘⌥L), type `@` in the reply box to list the agent sessions
running right now: each line shows the job, its lane, when it last spoke and
the last thing it said, with quiet sessions first. Keep typing to narrow by job
id, lane or last message. ↑/↓ move, Enter or Tab writes `@RQ-<job>` into the
message and Esc closes the list. Nothing is sent until you send the message; it
then names that job, exactly as if you had typed the id. Sessions without an
`RQ-` id are counted under the list but cannot be aimed at. A last message the
list does not hold reads "Last message unknown", and a list that does not
answer reads "Sessions unavailable", never "nobody is working". The list is
read only while it is open, from the same source as `phm sessions --json`.

In an empty reply box, ↑ brings back the messages you already sent in this
conversation, newest first; ↓ steps forward again and Esc clears the box.
Editing a recalled message makes it an ordinary draft.

Every fleet graph node offers Steer and Hand off. Both open the existing
message dialog for review before sending. Steer asks for a routing decision
when a node is exhausted, held or stale, and a neutral question otherwise.
Hand off asks which leader or engine should take the work. Readings are
quoted as displayed, including `unknown`. Long details are shortened while
preserving the requested action.

Desktop update inspection remains available with `phm app update status --json`;
see [desktop updates](../DESKTOP.md#background-update-discovery-and-local-status).
