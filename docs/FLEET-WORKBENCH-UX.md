# One engineering workbench

Product direction and acceptance criteria, not a claim that each interaction
below is implemented. The desktop shows what the fleet can prove, keeps the
Leader reachable, and opens the right evidence when a person asks for it.

## Keep the shell calm

- **Left rail:** the selected workspace, active sessions and this workspace's
  resource pool. Render the binding quota window, source and freshness. Show
  unknown separately from zero; put provider and machine detail behind the row.
- **Center:** default to fleet health and work moving through the system. Show
  exceptions, not a wall of status cards. Let a selected session, pull request,
  or release use this same space for its evidence rather than opening another
  dashboard.
- **Owner inbox:** one durable Leader thread with model, context, and dictation
  close to the composer. Channel delivery, received messages, agent decisions,
  and completed work are separate evidence. Keep interventions in context;
  reserve interruptions for a real decision or loss of capacity.
- **Controls:** keep pause, approval, and access controls in fixed locations.
  Prefer the service's sanctioned API, CLI or MCP. Use desktop control only
  where its app, window, and input scopes permit; a discovered app is not a
  permission grant.

## Show a task-specific view on demand

[Mudasir's merge-conflict reel](https://www.instagram.com/reel/DfD-qxGzjMB/)
suggests a useful interaction: give the operator a specific view of what is
blocking this change instead of making them parse a wall of text. Start with
a small, read-only catalog and the same data already used by the fleet panes.

| Question | Contextual view | Evidence |
| --- | --- | --- |
| Why isn't this PR merging? | Head, base, queue status, required checks and conflict reason; link to the existing PR or recut view | Exact head check and merge-queue receipts, with acquisition time |
| What happens when quota resets? | Binding quota and next reset with eligible jobs and alternate lanes, or an explicit unknown | Provider-scoped window and fresh scheduler eligibility, never an inferred paid fallback |
| Can this session move? | Current worker, proposed target, last acknowledged cursor and outstanding work | Current lease and handoff receipts; not-ready if continuity is unproven |

Use a bounded, versioned description of native Phantom components and opaque
evidence references. The host validates scope, schema, size, freshness and
identity, resolves references itself, and paints from its component catalog.
A model can choose presentation, not invent numeric state, render arbitrary
HTML, run code, open untrusted paths, or create a new action. Begin with
deterministic fixture-driven composition. If an agent chooses a layout later,
the safe component catalog and fallback stay identical. This follows
[A2UI's component catalog](https://a2ui.org/concepts/components/) without
requiring a new protocol dependency for the first slice.

Actions are not part of generated cards in the initial milestone. If a later
card can request an existing action, that intent must pass the same exact-head,
identity, permission and authority checks as any other caller. An unrecognized
or stale view falls back to stable evidence text and the canonical pane.

## Borrow the interaction, not the chrome

- [Codex](https://openai.com/index/introducing-the-codex-app/): parallel work,
  isolated worktrees and changes reviewed in the session that produced them.
- [Claude Code](https://code.claude.com/docs/en/claude-code-on-the-web): a clear
  session list and an activity panel next to the conversation, with permissions
  visible and preserved across resume.
- [Devin Desktop](https://cognition.com/blog/introducing-devin-desktop): local
  and cloud work, PRs and scoped project context in one command center.
- [Grok Bot](https://docs.x.ai/grok-bot/overview): an easy way to speak to a
  persistent teammate and see handoffs without managing every intermediate turn.
- [Cursor](https://cursor.com/docs/cloud-agent): an agent can be elsewhere while
  the work remains visible, with environment and repository boundaries explicit.

## Verify the first slice

1. Given a blocked PR with a fresh exact-head receipt, the selected item
   opens a readable evidence view without leaving the fleet workspace.
2. A missing, stale, or moved head cannot appear merge-ready. Missing values
   remain unknown and source time remains visible.
3. The view is keyboard-operable, readable at narrow desktop widths, and
   returns focus when closed. Opening it makes no mutating call, runs no
   command, and keeps the Owner inbox mounted.
4. Render from synthetic fixtures at normal and narrow widths. Measure how many
   steps it takes to identify the blocker and find the canonical evidence,
   not how many widgets the app shows.

The [console layout](CONSOLE-LAYOUT.md) still defines width behavior.
The [desktop operator policy](DESKTOP-OPERATOR.md) still defines app control.
