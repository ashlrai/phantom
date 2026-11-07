# Agent checkpoints

An agent can persist an explicit handoff as a UTF-8 JSON file in a location the
next session can access. Update it as the work changes and before compaction,
restart, or handoff. The author is responsible for recording all relevant
constraints, decisions and verification; the format cannot recover information
that was never written. Store references to evidence, not credentials or tokens.

```json
{
  "version": 1,
  "goal": "Complete the requested change under the agreed constraints.",
  "done": ["Implemented the parser; decision and rationale are in docs/design.md."],
  "next": ["Run the affected tests and investigate failures."],
  "evidence": ["docs/design.md", "test/example.test.ts", "Test command and result: npm test — passed."],
  "openQuestions": ["Does the caller require a migration?"]
}
```

All fields are required; the four lists may be empty. Entries and the goal must
be nonempty strings. Version 1 rejects unknown fields, malformed documents and
secret-shaped text rather than discarding or redacting content. Use binding names
for secrets. Keep the file private when its contents are private.

```sh
phm checkpoint resume ./checkpoint.json --json
```

The read-only command validates and prints the entire checkpoint as JSON, with no
section truncation. It exits 2 on invalid or unreadable input and does not echo
rejected content. A fresh agent should read the referenced evidence and inspect
current workspace state; pointers may have become stale. This is separate from
[Verse's bounded event-log handoff](VERSE-CONTEXT.md#4-handoff--continue-in-a-fresh-chat)
and the MCP gateway's access-control sessions. It grants no authority and does
not automatically capture state or initiate a session.

The public core contract is `parseAgentCheckpoint(raw: string): AgentCheckpoint`
and `readAgentCheckpoint(path: string): Promise<AgentCheckpoint>`; both reject
invalid input with `AgentCheckpointError`. The returned object has exactly the
fields shown above and preserves the authored strings and list order.
