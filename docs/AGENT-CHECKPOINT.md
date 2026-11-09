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

## Fleet worktree handoff

Keep the authored JSON outside the checkout, and refresh the durable copy while
work is in progress (not only at shutdown). The destination directory must
already exist and be accessible to the next lane:

```sh
phm checkpoint save /private/handoff.json /private/checkpoint.json /path/to/worktree --json
phm checkpoint resume /private/checkpoint.json --json
```

Save validates the handoff and appends the current Git HEAD and NUL-delimited
porcelain status, including untracked paths. It writes a private temporary file
and atomically replaces the destination. The handoff should describe decisions,
test commands and results, and next steps; Git cannot infer them. Save rejects
secret-shaped metadata, including paths, and never stages or publishes files.
Use a private shared destination for cross-lane access. The checkpoint records
paths, not file contents: retain the original worktree and inspect its state
before resuming. A different machine needs a separately secured transfer of the
worktree changes. Do not recreate or reset a registered fleet worktree; the
existing worktree and publisher safeguards still apply. Finish with the usual
BRIDGE_NOTES.md for publish.sh; a checkpoint grants no publish authority.

## Freshness and invalidation

`save` also records a `freshness` object (`savedAt`, `worktreeHead`,
`worktreeStatusDigest`, a SHA-256 of the porcelain status that ignores the
checkpoint file itself). It is optional in version 1, so hand-authored files
still parse and report `unverifiable`. Pass the worktree to resume to check it:

```sh
phm checkpoint resume /private/checkpoint.json /path/to/worktree
```

The output is `{ "checkpoint": ..., "freshness": { "state", "reasons" } }`.
`state` is `stale` (exit 3) when HEAD moved, the working-tree changes differ from
those saved, the checkpoint is over 24 hours old, or it is dated in the future;
`unverifiable` (exit 0) when it has no metadata; otherwise `fresh`. A stale
checkpoint is still printed, but treat its `done`, `next` and `evidence` as
unverified and re-inspect the worktree before acting on them.
