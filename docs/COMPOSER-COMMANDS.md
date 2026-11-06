# Composer Commands

The Phantom desktop console's prompt box (the chat input at the bottom of the composer) accepts
slash commands — type `/` at the start of your message to invoke one. Each command has an `id`, a
syntax, and a specific destination for its result.

## /handoff

**Syntax:** `/handoff [note]` (no parse function — sent as a chat turn)

Continues in a fresh chat with a handoff note.

**Landing:** The handoff note is posted as a turn in the existing chat; a new chat seat is created.

## /compact

**Syntax:** `/compact [note]` (no parse function — sent as a chat turn)

Summarises earlier turns to free context (sent as a turn).

**Landing:** Sent as a message turn in the current chat.

## /new

**Syntax:** `/new [note]` (no parse function — sent as a chat turn)

Starts a new chat on this seat.

**Landing:** A new chat is created on the current seat; any note is posted as a turn.

## /plan

**Syntax:** `/plan` (no arguments)

Switches this chat to Plan mode — nothing is edited.

**Landing:** The chat session enters Plan mode; result lands in the current chat.

## /effort

**Syntax:** `/effort <level>` (no parse function — sent as a chat turn)

Chooses the reasoning effort for the current chat.

**Landing:** Sent as a message turn in the current chat.

## /model

**Syntax:** `/model <model-id>` (no parse function — sent as a chat turn)

Chooses the model for the current chat.

**Landing:** Sent as a message turn in the current chat.

## /bus

**Syntax:** `/bus <to> <text>`

Posts a message to the agent bus (recipient = leaders, an agent name, or a job id).

**Parse errors:**
- "Use /bus <to> <text> to post to the agent bus." (no arguments)
- "Enter a printable ASCII recipient of at most 128 characters." (invalid `to`)
- "Enter a message to post to the agent bus." (no text)

**Landing:** POST /api/verse/fleet/agent-bus (the agent bus).

## /fleet

**Syntax:** `/fleet <text>`

Sends a message to the fleet leaders' inbox.

**Parse errors:** None — any non-empty text after `/fleet` is accepted (capped at
`FLEET_RUNS_INBOX_MAX_CHARS`).

**Landing:** POST /api/verse/fleet/runs/inbox → MASON-INBOX.md (see `composer/fleet-interject.ts`).

## /lane

**Syntax:** `/lane <lane> <n>`

Sets a fleet lane's worker target.

**Parse errors:**
- "Use /lane <lane> <n> to set a worker target." (wrong argument count)
- "Enter a valid lane name (2–40 lowercase letters, digits or hyphens)." (bad lane)
- "Enter a whole-number target from 0 to 999." (bad target)

**Landing:** POST /api/verse/fleet/lane/targets (see `composer/lane-target-command.ts`,
confirmation on a second send).

## /release

**Syntax:** `/release <lane> [reason]`

Releases a fleet lane hold, optionally with a reason (truncated to 200 chars).

**Parse errors:**
- "Use /release <lane> [reason] to release a lane hold." (no lane)
- "Enter a valid lane name (2–40 lowercase letters, digits or hyphens)." (bad lane)

**Landing:** POST /api/verse/fleet/control/holds (see `composer/lane-release-command.ts`).

## /pane

**Syntax:** `/pane <name>`

Opens a dock pane by id or a unique id/title prefix.

**Parse errors:**
- "Use /pane <name> to open a dock pane." (no name)
- "Ambiguous pane: ..." (multiple matches)
- "No pane named ..." (no match)

**Landing:** Opens a dock pane by name in the desktop console (see `composer/pane-command.ts`).
