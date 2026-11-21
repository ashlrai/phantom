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

### Reach a session by typing

A reply that starts with `/` and names a command runs on Enter instead of
being sent; `/help` lists them all. Five of them are about sessions. They
only read, so they need no unlock and leave no note in the Leader inbox:

| Type | What happens |
| --- | --- |
| `/who` | One line in the conversation naming the sessions working now (quiet ones first, eight at most, the rest counted), each with its lane and when it last spoke. |
| `/thread <session>` | Opens that session as a conversation in the Leader pane (beside the chat when there is room, over it otherwise) and says its state and lane. Esc in the conversation returns to the reply box. |
| `/summary <session>` | Prints the session's state, lane, model, when it last spoke and its recorded summary, without leaving the chat. |
| `/log <job-id>` | Opens the job's live log. |
| `/find <words>` | Looks for the words in every session's whole conversation and answers in the chat: how many sessions hold them, then a row for each of the first six with its state, how many of its messages match and the newest line that does. |

Type `@` after the command to pick the session from the list above; the `@`
is dropped. A job id in a command's answer is a button that opens that session
as a conversation the same way, so `/who` is also a way into any of them; the
id is underlined while its conversation is the one open. `/thread` on a
name the session list does not hold opens nothing and says so. When the list
does not answer, `/who` reads "Working sessions are unknown" with the reason,
and `/thread` opens the name unchecked and says that. The reads are the ones
behind `phm sessions --json` and `phm sessions thread <id> --json`.

`/find` asks what the find box in Conversations asks (`phm sessions find <words> --json`), across
every lane and repo, for words of two letters or more; a session must hold
all of them. A quoted line is cut around the first word found. Sessions past
the sixth are counted, with a pointer to the Conversations find box, which
lists them all. When the search does not answer, or the server is too old to
have it, the line says the answer is unknown and why; it never reads as
"no session holds them". What the search could not read is named under the rows.

### See and open the Mac's apps by typing

Two more commands reach the apps on the Mac Phantom runs on, through the
same routes as the Mac host pane's Apps and App actions cards:

| Type | What happens |
| --- | --- |
| `/apps` | One line in the conversation: each known app with its state (in front, running with its memory, not running, running unknown), the ones not installed named last, then the newest thing Phantom did to an app and how many actions on record did not go through. It only reads, so it needs no unlock and leaves no note. |
| `/app <name>` | Opens that app, or brings it to the front when it is already running: the one action its row on the Apps card offers. The name is the app's id, its full name, or enough of the start to fit one app (`/app cur` for Cursor). It needs the unlock, asks for no confirm, and a done action leaves a `[composer] /app <name>: done` note in the Leader inbox. |

`/app` reads the app list first and runs nothing when the name fits no app or
more than one, when the app is not installed, or when its row offers no
action (Phantom itself, or the app already in front). The allowlist, request
mode, KILL and the comms pause apply as they do to `phm apps open claude
--json`: a refusal is shown with the server's reason and leaves no note, and a
request-mode app answers that the request went to needs-you. There is no quit
or restart from the reply box. When a read does not answer, that half of the
`/apps` line says it is unknown and why; away from the Mac both halves say
they can be read only there. The reads are the ones behind `phm apps --json`
and `phm apps log --json`.

### Pick a command's argument from a list

After a command that takes an argument, a space opens a list of what the
command accepts, in the same place as the `@` list:

| After | The list holds |
| --- | --- |
| `/release ` | The lanes that are held, each with the hold's reason and, when one is set, the time it ends. |
| `/hold ` | Every lane, the ones not yet held first with their target. Choosing one leaves a space for the minutes. |
| `/stop ` | The jobs running now, with lane, when each last spoke and its last words; a quiet one is marked. |
| `/log ` | Every job in the session list, running ones first, then finished and failed ones. |
| `/thread `, `/summary ` | Every session in the list, the Leader and helpers included. |
| `/app ` | The apps `/app` can open or bring to the front, each with its state and which of the two it would do. |
| `/open ` | The panes, by the id `/open` takes, each with its title. |

Keep typing to narrow the list by name, or by lane, state or last words.
↑/↓ move, Tab writes the highlighted row into the box, Esc closes the list
and a click writes the row too. Enter writes the highlighted row only while
nothing is typed after the command yet, or after the arrows moved; otherwise
Enter runs the command exactly as typed, so a full id typed by hand is never
replaced by a longer match; the same holds for a session typed in full
after `@` in a command. Choosing a row only writes text: nothing runs
until you press Enter on the finished command, with the same unlock and
confirm as before.

Each list is read only while it is open, through the read the matching pane
makes (lane holds, `phm sessions --json`, `phm apps --json`, the pane
menu). A list that does not answer reads "Lanes unavailable", "Sessions
unavailable" or "Apps unavailable" with the reason, never "No lane is held
right now", and the argument can still be typed by hand. A lane record that
is degraded, or a session list that could not be read in full, says so under
the rows.

Every fleet graph node offers Steer and Hand off. Both open the existing
message dialog for review before sending. Steer asks for a routing decision
when a node is exhausted, held or stale, and a neutral question otherwise.
Hand off asks which leader or engine should take the work. Readings are
quoted as displayed, including `unknown`. Long details are shortened while
preserving the requested action.

## See who is working from the Leader pane

The Leader pane (⌘⌥L) opens with a **Working now** strip above the
conversation: one line per running agent session, with its lane, when it last
spoke and the last thing it said. Quiet sessions come first. A last message the
sessions list does not hold reads "Last message unknown", and a list that does
not answer reads "Sessions unavailable", never "nobody is working". Sessions
whose state is unknown are counted beside the running ones.

Choose a line to put `@RQ-<job>` in the reply box. Nothing is sent until you
send the message. Helpers without an `RQ-` id are listed but cannot be aimed
at.

**Thread** reads that session as a conversation without leaving the pane: a
summary assembled from its records, what it was told, what it said and did,
and a reply box aimed at it (the same view as a Sessions pane row; see
[sessions](SESSIONS.md)). In a pane at least 900 px wide the conversation
opens beside the Leader chat: the chat, its reply box and the strip stay on
screen, the open line is marked, and **Thread** on another line swaps the
conversation in place. Esc or **Close** closes it. In a narrower pane the
conversation covers the chat, and Esc or **← Leader** returns to it, where an
unsent draft is still in the reply box. Above the open conversation, **‹** and
**›** (or `[` and `]` outside a text field) step to the previous and next
working session and say where it stands, for example "2 of 5 working"; a
session that has stopped working reads "Not working now". **Log** opens the job in the
Worker log, **PR** opens its pull request and **All sessions** opens the
Sessions pane. With a line focused, ↑/↓ or J/K move, Enter aims, T opens the
conversation and L opens the log. The strip folds to its count line and stays
folded until you open it again. It reads the same list as:

```sh
phm sessions --json
```

Desktop update inspection remains available with `phm app update status --json`;
see [desktop updates](../DESKTOP.md#background-update-discovery-and-local-status).
