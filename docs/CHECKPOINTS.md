# Agent-managed checkpoints

`PHANTOM_CHECKPOINTS=1` enables explicit working-memory checkpoints. The feature
is off for every other value. Existing context-window compaction stays the default.

With the flag enabled, `runTask` uses `~/.phantom/checkpoints`, the current repository,
and a run-scoped key (or a generated unique key without an effect-journal scope).
For restartable sessions, hosts supply
`checkpoint: { directory, key, repoRoot }`, then set `resume: true` on restart.
Use a private directory and a stable task key, with one host writer per key.
The host owns these options; model arguments cannot choose storage paths.
With the flag enabled, tool-capable models get `phantom_checkpoint`, which
must be called alone. It supplies:

```json
{
  "objective": "Repair the parser",
  "verified_facts": [{ "text": "The closing delimiter is required", "evidence_ref": "completed-tool-event-id" }],
  "open_hypotheses": ["The lexer may also need a change"],
  "failed_approaches": ["Removing the delimiter broke parsing"],
  "next_actions": ["Add a regression test"]
}
```

The host adds `revision` and `created_at`. Each verified fact must reference a
successful completed tool event recorded by this checkpoint store. Missing or
unknown references move the claim into `open_hypotheses`. Evidence proves an
observation occurred, not that an agent's interpretation is correct. Tool event
metadata includes an identifier and result digest; it does not retain raw results.

Saving a checkpoint replaces the model's working transcript with the checkpoint
and newly observed repository state, alongside host system instructions. Restart
with the same directory, key and repository to resume. The old transcript is not
part of resumed context. Checkpoints do not grant tool, mutation or spending
authority. Recheck mutable facts before acting.

## Offline comparison

Run one bounded scripted fixture through fixed-interval compaction and explicit
checkpoint-resume:

```sh
PHANTOM_CHECKPOINTS=1 npm run dev -- eval checkpoints --file fixture.json --json
```

Example `fixture.json`:

```json
{
  "task_id": "parser-retention",
  "objective": "Repair the parser",
  "system_instructions": "Verify before editing.",
  "fresh_repo_state": "Fixture snapshot: HEAD abc123; working tree clean",
  "fixed_interval": 1,
  "turns": [
    {
      "prompt": "Inspect the parser",
      "assistant": "Read the parser",
      "tool_event": { "id": "read-1", "name": "read_file", "result": "The closing delimiter is required" },
      "fixed_summary": "Investigated the parser",
      "checkpoint": {
        "objective": "Repair the parser",
        "verified_facts": [{ "text": "The closing delimiter is required", "evidence_ref": "read-1" }],
        "open_hypotheses": [],
        "failed_approaches": [],
        "next_actions": ["Add a regression test"]
      }
    },
    { "prompt": "Finish the repair", "assistant": "Done" }
  ],
  "assertions": { "contains": ["The closing delimiter is required"], "excludes": [] }
}
```

Both strategies replay identical prompts and successful tool events. Fixed
compaction uses the supplied `fixed_summary` at every `fixed_interval` boundary;
checkpoint-resume uses only explicit `checkpoint` boundaries. At least one reset
for each strategy is required. `fresh_repo_state` is a scripted observation shared
by both arms, not a live Git probe.

The report emits `input_tokens`, requests, resets and task outcome for both
strategies. Counts use `conservative-request-reservation-v1`, the existing UTF-8
request reservation estimator, including framing. They are conservative estimates,
not provider tokenizer measurements or billed usage. Checkpoint-generation and
summary-generation costs are outside this scripted replay. Outcomes evaluate
contains/excludes assertions against the final request context, before the final
scripted answer; a fixture cannot declare its own pass status. This diagnoses
retention on that fixture and does not establish real-task success or token savings.

`runCheckpointConditionD(fixture, env)` in
`src/core/local-eval/checkpoint-comparison.ts` exports the hook for
`RQ-AGL-EVAL-1`, condition D. The evaluation host owns real-task checking,
repetitions and provider usage collection. The CLI is offline, reads at most
1 MiB from a safe regular file, emits aggregate data only, and launches no tools
or models.
