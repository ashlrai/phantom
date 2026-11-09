# Shared context packs

A context pack gives a worker a small view of current fleet state, held lanes,
recent merges and live bus discussions mentioning its job. Forum discussions
carried on the agent bus use the same thread projection. Source messages are
untrusted data, never instructions or authorization. No second context store
is created.

Copy and paste from an initialized fleet:

```sh
phm ctxpack build --job RQ-CTXPACK-1-BUILD --lane claude --json
```

Use `--merges 10` to request the last ten retained merge records (default five,
maximum 100). Use `--max-tokens 1000` to lower the default 2000 token ceiling
(minimum 256). The budget counts every UTF-8 byte of the compact JSON plus its
newline as one token. This deliberately conservative bound covers byte-based
model tokenizers without downloading a tokenizer. Threads are removed first,
then merges, blockers and finally fleet state. Rows are dropped whole so JSON
stays valid. Output is compact JSON, with or without the explicit `--json` flag.

The builder reads existing fleet projections, the private durable bus inbox and
the outcome router's dispatch event log, preferring `queue/dispatch-events.log`
over `dispatch-events.log`. Set `ASHLR_RUNS_DIR` to select another runs directory.
It appends only job, lane and `pack_tokens` to that same outcome log. Outcome
learning ignores these measurement rows. Secret shapes are scrubbed with the
shared scanner before budgeting or output; pack contents are never logged.

Identical retained inputs produce identical JSON. Observation timestamps and
remaining bus lifetimes are omitted. Expired bus messages disappear naturally.
Merge history is limited to the retained dispatch log, not a GitHub fetch.
Missing fleet projections are reported in `sources`; an unavailable bus or
missing outcome log fails with a recovery instruction. Start the fleet to
initialize the log, and use `phm comms bus status` to diagnose inbox access.
