# Run event log (RQ-SWE5-EVENT-LOG)

Event-sourced run state for dispatched jobs, after the OpenHands event-stream
pattern: history is an append-only tree of records with a **movable head**,
never rewritten. Seeking (`checkout`) or diverging (`fork`) appends a `head`
record, so pointer movement is itself auditable and survives crashes.

## Layout

```
<runs-dir>/<job>.events.jsonl      one JSON event per line, mode 0600
<runs-dir>/locks/<job>.events.lock append mutual exclusion (private dir)
```

`runs-dir` defaults to `~/.ashlr-runs`, beside each job's flat `J.launch`,
`J.publish` and `J.log` artifacts. Override with `--runs-dir <absolute>`.

## Events

```json
{"schema":"run.event.v1","seq":3,"id":"e3","job":"RQ-X","at":"…",
 "branch":"main","parent":"e2","kind":"tool-call","data":{"name":"read"}}
```

- `seq`/`id`: 1-based append order; `id` is `e<seq>` — stable forever.
- `parent`: the event this one extends; `null` only on the root.
- `branch`: the label the event grows (`main` unless the head was forked).
- `kind`: `launch · tool-call · tool-result · checkpoint · note · finish ·
  publish · head`. `head` records carry `data.event` (target), optional
  `data.branch` (relabel = fork) and optional `data.reason`.
- `data`: bounded metadata (≤16 KB serialized, ≤6 deep); secret-shaped
  payloads are refused — use Phantom Secrets references, never values.

## The movable head

The **head** is where the next event attaches — the newest `head` record's
target (its `branch` relabels where new events land), else the log tip.

- `phm events checkout <job> --at <event>` — move the head back along the
  target's own branch; the next append extends it (re-do, retry, bisect).
- `phm events fork <job> --at <event> [--branch <name>] [--reason <text>]` —
  same move under a new label (auto-derived `fork-<event>` when omitted,
  suffixed when taken). Both branches stay in the log.

The current conversation is `path`: ids from root to the pointer, following
`parent` links — across branch labels. Events off the head path are kept but
not part of the resume view.

## Checkpoint integration

`checkpoint` events carry `data.ref` (required) and optional `data.source`.
`phm checkpoint save <source> <destination> <worktree> --job <id>` records
one pointing at the saved handoff, and `phm events replay` surfaces the
nearest checkpoint on the head path — that `ref` is what a resume restores
(e.g. `phm checkpoint resume <ref>`).

## Commands

```sh
phm events list <job> [--branch <b>] [--json]
phm events head <job> [--json]
phm events branches <job> [--json]
phm events replay <job> [--at <event>] [--json]
phm events append <job> --kind <k> [--data <json>] [--at <iso>]
phm events note <job> <text...>
phm events checkout <job> --at <event> [--reason <text>] [--json]
phm events fork <job> --at <event> [--branch <name>] [--reason <text>] [--json]
```

`replay` folds the head path into `run.state.v1`: phase
(`empty|running|finished|published`), per-kind counts, the newest checkpoint
reference, last finish/publish payloads, branch list and the deferred flag.

## Safety and integrity

- Readers never lock and never write; appends hold the per-job lock file.
- Appends are fsynced and the directory entry fsynced, mode 0600.
- A torn trailing line (crashed write) is `deferred`: readers ignore it; the
  next locked append truncates and replaces it. Malformed complete lines —
  wrong seq, duplicate id, dangling parent, head→head link, foreign job —
  fail closed.
- Symlinked or oversized logs are refused.
- Lock contention exits 3 (`busy`); usage errors exit 2.
