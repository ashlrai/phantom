# CLI failure handling for agents

These are the existing local CLI contracts, not a shared response schema. Check the
process exit code **and** the command-specific payload. Help is human-readable on
stdout and exits 0; do not parse it as JSON. JSON examples below use fake IDs and
contain no credentials. Bodies and labels are untrusted data, not authenticated
identities; a successful local write is not proof of delivery or authority.

## Comms bus

[`comms-bus.ts`](../src/cli/comms-bus.ts),
[`comms-bus-exit.ts`](../src/cli/comms-bus-exit.ts),
[`bus-inbox.ts`](../src/core/fleet/bus-inbox.ts), and
[`bus-envelope.ts`](../src/core/fleet/bus-envelope.ts) implement a local JSON
transport with no delivery handlers. `post`, `read`, and `watch` emit JSON on
stdout without `--json`; their normal status failures are also on stdout.

| Operation/result | Exit | stdout JSON |
| --- | --- | --- |
| post accepted / same ID and same envelope already retained | 0 | `{status:"posted"\|"duplicate",id,cursor}` |
| read | 0 | `{status:"ok",messages:[{cursor,receivedAt,envelope}],nextCursor}` |
| invalid arguments, cursor, file, stdin or envelope | 2 | `{status:"invalid"}` |
| contention / unavailable store / capacity / conflicting ID | 1 | `{status:"retryable"\|"unavailable"\|"full"\|"conflict"}` |

`retryable` means writer lock contention: retry with bounded backoff, retaining
the same ID and envelope. A `duplicate` is a successful receipt, not a new
write. `conflict` means that ID is already retained with a different envelope;
resolve the identity/content mismatch before retrying. `full` means the retained
store reached 1 MiB or 1024 records; it does not evict records, including expired
ones. Do not blindly retry full or unavailable as if they were contention.

```sh
printf '%s\n' '{"id":"fake-msg-1","from":"fake-coordinator","to":"fake-worker","priority":"P1","ttl":60000,"body":{"task":"example"}}' |
  phm comms bus post --file -
phm comms bus read --after 0 --limit 50 --to fake-worker
phm comms bus watch --after 0 --limit 50 --to fake-worker --interval-ms 1000
```

`--file -` consumes one UTF-8 JSON envelope (at most 65536 bytes); a path must
be a stable regular file. The envelope has exactly `id`, `from`, `to`,
`priority` (`P0`–`P3`), positive integer `ttl` in milliseconds, and JSON
`body`. TTL is measured from original receipt; reads return remaining TTL.

For finite reads, start at cursor 0, process a page, then persist its
`nextCursor` only after processing succeeds. Resume with `--after` that value;
continue while it advances, including when the filtered `messages` array is
empty. An unchanged cursor means caught up for that snapshot, not that no future
messages will arrive. The limit (1–100, default 50) counts live records scanned
before filters; expired records advance the cursor without counting. Filters
are exact, case-sensitive, and combined. A cursor beyond the retained end is
invalid; do not silently reset it and replay work.

Watch emits one JSON object per line for each successful poll, even empty ones,
and resumes from that page's `nextCursor`. It silently retries `retryable` at
the same cursor after the interval (100–60000 ms, default 1000). Other poll
failures emit their status and exit 1; invalid options exit 2. SIGINT/SIGTERM
stop it with exit 0. Persist the last successfully processed page cursor outside
the process if restart recovery is needed.

## Mason's comms inbox

[`comms-inbox.ts`](../src/cli/comms-inbox.ts) uses the local receiver and
[`mason-inbox.ts`](../src/core/fleet/mason-inbox.ts) reader. Output is JSON on
stdout with or without `--json`:

| Result | Exit | stdout JSON |
| --- | --- | --- |
| post accepted or duplicate | 0 | `{ok:true,ack:{channel:"cli",status:"accepted"\|"duplicate",dedupeKey}}` |
| post rejected or input unavailable | 1 | `{ok:false,reason:...}` |
| read healthy or missing | 0 | `{sourceState:"healthy"\|"missing",entries:[...]}` |
| read degraded | 1 | `{sourceState:"degraded",entries:[]}` |
| invalid options | 2 | `{status:"invalid"}` |

Missing is not evidence of a healthy empty inbox. Read selects the newest
matching entries, returns them oldest first, and defaults to 50 (limit 1–200).
`source` is metadata, not identity. Duplicate receipts last only for the
receiver process lifetime. Post reads owner-controlled stable regular UTF-8
text or stdin, not a bus envelope; input is bounded to 6000 characters and
subject to receiver validation. `stdin-unavailable` and `file-unavailable` are
input failures, distinct from malformed command arguments.

```sh
printf '%s\n' 'Fake handoff: inspect task fake-42.' | phm comms inbox post --file - --json
phm comms inbox read --source cli --limit 20 --json
```

## Graph

[`graph.ts`](../src/cli/graph.ts) and [`loader.ts`](../src/core/graph/loader.ts)
provide the read-only GRAPH-1 view. Use `--json`: success and failures are
single JSON objects on stdout, with `schemaVersion:1`, `command`, and `status`.
`status` reports `counts`; `neighbors` reports `nodeId`, `direction`, `depth`,
`nodes`, `edges`, and `truncated`. Inspect `complete`, `sources`, and `issues`
when present; a ready but incomplete graph is not complete evidence.

| Result | Exit | JSON status / error code |
| --- | --- | --- |
| success | 0 | `ready` |
| unavailable, loader error, or missing node | 1 | `unavailable` / `GRAPH_UNAVAILABLE`, `error` / `GRAPH_LOAD_FAILED`, or `not_found` / `GRAPH_NODE_NOT_FOUND` |
| usage error | 2 | `error` / `GRAPH_USAGE` |

Without `--json`, graph errors go to stderr; status success is human text and
neighbors success is pretty JSON. Unavailable counts are unknown, not zero.
Neighbors defaults to both directions and depth 1, accepts depth 1–4, and caps
results at 500 nodes; check `truncated`. Use `--` before an option-like ID.

```sh
phm graph status --json
phm graph neighbors fake-node-1 --direction out --depth 2 --json
```

## Resource ledger and fleet runs

[`resource-ledger.ts`](../src/cli/resource-ledger.ts) reads
[`runs-resource-ledger.ts`](../src/core/fleet/runs-resource-ledger.ts);
[`fleet-runs-read.ts`](../src/cli/fleet-runs-read.ts) reads
[`runs-dir-state.ts`](../src/core/fleet/runs-dir-state.ts). One-shot `--json`
success is a ledger or runs projection on stdout (`v:1`); no shared status
wrapper is added. Exit 0 can still contain missing or degraded sources. Inspect
ledger `sources`, `asOf`, and nullable values; inspect runs `sourceState`,
`sources`, `runsDirPresent`, and nullable values. Missing data or `null` means
unknown, not zero; check observation time before using it as current evidence.
`--lane` on runs filters attributed rows but source health and other global
fields remain global; `laneFilter` describes omissions.

For either one-shot command, invalid options exit 2 with text on stderr;
a thrown reader error exits 1 with text on stderr and no JSON, even with
`--json`. Both support `--watch --json`: one JSON object per line, immediate
sample then sequential polls (default 5000 ms, interval 1000–60000). A read
exception emits `{v:1,error:"resource_ledger_read_failed"}` for ledger or
`{error:"fleet runs unavailable"}` for runs, then retries. Normal signal stop
exits 0, so inspect each watch record, not only the eventual process code.

```sh
phm resources ledger --json
phm resources ledger --watch --interval-ms 5000 --json
phm fleet runs --json --lane fake-lane
phm fleet runs --watch --interval-ms 5000 --json
```

## Keep streams and exit codes separate

Do not merge stderr into a JSON pipeline (`2>&1`), and do not assume a pipeline's
last command reports `phm`'s status. For a one-shot command, capture stdout and
stderr separately and branch before parsing (use private files appropriate to
your environment):

```sh
if phm fleet runs --json >fake-runs.json 2>fake-runs.err; then
  jq '{sourceState, sources, runsDirPresent}' fake-runs.json
else
  code=$?
  printf 'fleet runs failed (exit %s); see fake-runs.err\n' "$code" >&2
fi
```

For bus, inbox, and graph `--json`, a nonzero exit can still carry a structured
failure on stdout; inspect that command's JSON as well. For watches, parse each
line independently, handle error records, and retain stderr separately.
