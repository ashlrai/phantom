# Checkpointed bus consumer

From the repository root, read one bounded page for a routing address and durably
resume from a checkpoint file:

```sh
npx tsx examples/agents/bus-checkpoint.ts --to fake-worker-b --checkpoint "$ASHLR_HOME/fleet/fake-worker-b.checkpoint.json"
```

`--to` and `--checkpoint` are required. `--limit` defaults to 50 (valid range
1–100) and bounds live records read per poll, including records for other
addresses, rather than the number of matches. `--wait` defaults to 0 (valid
range 0–60000 milliseconds): when no matching record is found, the consumer
re-polls the inbox every 250 ms until a match arrives or the wait budget is
spent, then emits whatever the last page held — usually an empty page.

The single JSON object on stdout has `status` (`ok`), `to`, `resumedFrom`,
`nextCursor`, `waitedMs`, and `messages` (matching inbox receipts). The cursor
advances across every scanned record — expired and nonmatching included — so an
empty filtered page still advances the checkpoint, exactly like
[bus-resume](bus-resume.md).

The checkpoint file is a small JSON object:

```json
{"schemaVersion":1,"to":"fake-worker-b","cursor":12,"updatedAt":1761930000000}
```

- **Missing file** starts at cursor 0 and is created on the first successful run.
- **Present but malformed, oversized, or unreadable** refuses with
  `checkpoint-malformed` / `checkpoint-unavailable` — never a silent reset to 0.
- **Address mismatch** (`to` inside the file differs from `--to`) refuses with
  `checkpoint-mismatch`; keep one checkpoint file per routing address.
- **Cursor beyond the store head** refuses with `checkpoint-stale` rather than
  skipping or rewinding.

The file lives beside `*.pending-*` sibling temporaries and is replaced
atomically (create-secure, fsync, rename) only **after** stdout accepts the
emitted page. A crash after emission but before the rename can therefore replay
the page on the next run — delivery is at-least-once, never exactly-once — but
the checkpoint is always either the complete old file or the complete new one.
The checkpoint directory must be owned by the current user and not writable by
group or others (for example, not a shared `/tmp` directory). One consumer per
checkpoint file: concurrent writers on the same file race the cursor.

SIGINT/SIGTERM during `--wait` stops polling, detaches the signal handlers, and
exits `130` with nothing emitted and the checkpoint untouched. Message bodies
are emitted as untrusted data and are never executed. Addresses are routing
labels, not authenticated identities. The default inbox is Phantom's local
fleet inbox (`$ASHLR_HOME/fleet` when `ASHLR_HOME` is absolute, otherwise
`~/.ashlr/fleet`); the same `BusInboxOptions` reader as `bus-resume` validates
the store and returns remaining TTLs.

Exit codes: `0` ok · `1` inbox or internal failure · `2` invalid arguments ·
`3` checkpoint problem (`checkpoint-unavailable`, `checkpoint-malformed`,
`checkpoint-mismatch`, `checkpoint-stale`) · `4` page emitted but checkpoint
write failed (next run replays) · `5` output sink failed (checkpoint
preserved) · `130` interrupted. Failures print `{"status":"<name>"}` as JSON on
stderr and leave stdout empty.
