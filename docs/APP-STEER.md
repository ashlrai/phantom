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

Every fleet graph node offers Steer and Hand off. Both open the existing
message dialog for review before sending. Steer asks for a routing decision
when a node is exhausted, held or stale, and a neutral question otherwise.
Hand off asks which leader or engine should take the work. Readings are
quoted as displayed, including `unknown`. Long details are shortened while
preserving the requested action.

## Aim at a running job from the Leader pane

The Leader pane (⌘⌥L) opens with a **Working now** strip above the
conversation: one line per running agent session, with when it last spoke and
the last thing it said. Quiet sessions come first. A last message the sessions
list does not hold reads "Last message unknown", and a list that does not
answer reads "Sessions unavailable", never "nobody is working".

Choose a line to put `@RQ-<job>` in the reply box. Nothing is sent until you
send the message; it then names that job, and the
conversation shows that job's outcome under it. Helpers without an `RQ-` id
are listed but cannot be aimed at.

**Thread** reads that session as a conversation without leaving the pane: a
summary assembled from its records, what it was told, what it said and did,
and a reply box aimed at it (the same view as a Sessions pane row; see
[sessions](SESSIONS.md)). Esc or **← Leader** returns to the Leader chat,
where an unsent draft is still in the reply box. **Log** opens the job in the
Worker log, **PR** opens its pull request and **All sessions** opens the
Sessions pane. With a line focused, ↑/↓ or J/K move, Enter aims, T opens the
conversation and L opens the log. The strip folds to its count line and stays
folded until you open it again. It reads the same list as:

```sh
phm sessions --json
```

Desktop update inspection remains available with `phm app update status --json`;
see [desktop updates](../DESKTOP.md#background-update-discovery-and-local-status).
