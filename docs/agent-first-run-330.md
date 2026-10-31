# Agent first run — Phantom 3.30 CLI

A source-backed runbook for a coding agent with shell access on Mason's host.
Every command below exists in the shipped 3.30 CLI; the wire shapes quoted are
the real outputs of the implementing modules. None of these commands contacts
a provider or spends money. Only §3's optional post and §4 write anything,
and only into local stores on this host. Deeper failure semantics live in
[AGENT-CLI-CONTRACTS.md](AGENT-CLI-CONTRACTS.md).

## 1. Install or upgrade, then prove the version

Requires Node.js 22.15.0 or newer.

Fresh install:

```sh
node --version                      # must print v22.15.0 or newer
npm install -g @ashlr/phantom
phm --version                       # prints the installed version, e.g. 3.30.0
```

Upgrade from 3.29.15 — same install command, same check:

```sh
npm install -g @ashlr/phantom
phm --version                       # must now print a 3.30.x version
```

The whole orientation surface in this runbook is new in 3.30. Published
3.29.15 has no `phm comms bus`, no `phm comms inbox`, and no
`phm fleet runs|journal|parked|job` verbs; its `phm comms` answers
"unknown subcommand" for them. After upgrading, probe each command's help
before relying on it — help prints usage and exits 0:

```sh
phm comms bus --help
phm fleet runs --help
phm fleet job --help
phm comms inbox --help
```

`phm` and `ashlr` are the same binary; this runbook uses `phm`.

## 2. Inspect the fleet (read-only)

All fleet reads observe the host runs directory `~/.ashlr-runs` and the
`~/.ashlr` home. Exit 0 can still carry missing or degraded sources —
`missing`/`unknown` means absent evidence, not an empty fleet. Check
`sourceState`/`sources` before treating a projection as current.

```sh
phm fleet runs --json       # lanes, running vs target, queued, held, last tick
phm fleet parked --json     # parked queue: totals, ready/parked by lane, hold reasons
phm fleet journal --json    # leader journal: recent passes, ingest and reject rows
```

`--lane <lane>` filters lane-attributed rows on `runs` and `parked`; totals
and source health stay global.

One job and its notes (job IDs match `[A-Za-z0-9][A-Za-z0-9._-]{2,79}`):

```sh
phm fleet job <job-id> --json        # state, lane, tier, model, publish evidence, log tail
phm fleet job <job-id> --notes       # the worker's bridge-notes artifact (scrubbed)
phm fleet job <job-id> --log --tail-lines 20
```

Job detail is artifact evidence (`fleet.job.v1`); process liveness is not
checked. `--notes` reads a scrubbed worker artifact and exits 1 when none is
recorded. `phm fleet workers --json` lists live worker processes if you also
need liveness.

## 3. Read Mason's inbox

```sh
phm comms inbox read --limit 20 --json
```

Reads `~/.ashlr-runs/leader/MASON-INBOX.md` and prints one JSON object:
`{sourceState, entries:[{at, source, priority, text}]}`. `sourceState` is
`healthy`, `missing` or `degraded`; a missing inbox is not a healthy empty
one, and `degraded` exits 1. Read selects the newest matching entries and
returns them oldest first; `at` is the entry's local time in
`America/New_York` (`YYYY-MM-DD HH:MM`). `--source`, `--priority`,
`--after`/`--before` (RFC 3339 with zone) and `--limit 1..200` filter;
`source` is metadata, not identity.

Optionally leave Mason a plain-text note (this writes the same file; it is
not a bus envelope and is capped at 6000 characters):

```sh
printf '%s\n' 'fake note: new agent online, runbook complete' | phm comms inbox post --file - --json
```

Post answers `{ok:true, ack:{channel:"cli", status:"accepted"|"duplicate",
dedupeKey}}`; the stored entry's `source` is `cli`. The CLI adapter is
verified only as `local-operator` — see §5. Writing the file does not send
anything to Mason's phone.

## 4. Exercise the local bus

The bus is a bounded local JSON transport under
`$ASHLR_HOME/fleet/bus-inbox/messages.json` (`~/.ashlr/fleet/…` by default).
It has no delivery handlers: `posted` means retained in the local store, not
delivered, read, or acted on.

```sh
phm comms bus status
```

Status prints `{source, retainedCount, retainedBytes, maxMessages, maxBytes,
liveCount, expiredCount}` — metadata only, no bodies. `source` is `missing`,
`available`, or `unavailable` (exit 1); missing/unavailable counts are `null`,
not zero.

Post one fake envelope. The wire contract is exactly six fields — `id`,
`from`, `to`, `priority` (`P0`–`P3`), `ttl` (positive integer milliseconds),
and `body` (any strict JSON) — at most 65536 UTF-8 bytes total; `id`/`from`/`to`
are printable-ASCII tokens of 1–128 characters:

```sh
cat > /tmp/fake-envelope.json <<'EOF'
{"id":"fake-hello-1","from":"fake-agent","to":"fake-coordinator","priority":"P3","ttl":300000,"body":{"note":"first-run check"}}
EOF
phm comms bus post --file /tmp/fake-envelope.json
```

(`--file -` reads one envelope from stdin.) Post answers
`{status:"posted",id,cursor}`; the same ID with the identical envelope is a
successful `{status:"duplicate"}`, and the same ID with different content is
`{status:"conflict"}`. Other statuses: `invalid` (exit 2), `retryable`
(writer contention — retry with backoff, same ID and envelope),
`unavailable`, `full` (all exit 1).

Read the receipt back, then resume from the cursor:

```sh
phm comms bus read --after 0
phm comms bus read --after 0 --id fake-hello-1
phm comms bus read --after <nextCursor>
```

Read answers `{status:"ok", messages:[{cursor, receivedAt, envelope}],
nextCursor}`; each message row is the stored receipt — the persistent integer
`cursor`, the epoch-ms `receivedAt`, and the validated envelope. Semantics:

- The cursor starts at 0 and never resets. Process a page, then persist its
  `nextCursor` only after processing succeeds; resume with `--after` that
  value. A cursor beyond the retained end is `invalid`.
- Expired records advance the cursor but are not returned, so an empty
  `messages` with an advanced `nextCursor` is normal. `ttl` in a returned
  envelope is the *remaining* milliseconds; reads never renew it.
- `--limit` is 1–100 (default 50) and counts scanned live records before
  filtering. `--id`, `--to`, `--from`, `--exclude-from`, `--priority` are
  exact, case-sensitive, and combined.
- `phm comms bus watch` polls the same pages for a live tail.

Full store: retained capacity is 1 MiB or 1024 records, whichever is reached
first, and nothing is ever evicted — expired records still occupy capacity.
Detect it from `status` (`retainedCount` at `maxMessages`, or `retainedBytes`
at `maxBytes`) or from a `post` answering `{status:"full"}`; do not retry a
full store as if it were contention.

## 5. Trust boundary — local owner vs verified remote identity

- Local owner trust: every command above runs as the local OS user against
  that user's `~/.ashlr` and `~/.ashlr-runs`, and the stores enforce
  owner-only permissions (0700 directories, 0600 files). The local process
  owner is the trust boundary: running these commands proves you are a local
  operator, nothing more.
- The inbox CLI is verified only as `local-operator` — the canonical sender
  ID the adapter itself supplies; a sender ID asserted inside a message body
  is never identity. Only a trusted channel adapter that authenticated its
  remote side (for example the Telegram adapter verifying the configured bot
  chat) produces a verified remote sender; the `cli` channel does not
  authenticate internet or email senders.
- Bus `from`/`to`, inbox `source`, and `priority` are routing labels and
  metadata — exact and case-sensitive for filtering, but they confer no
  authenticated identity or authority. Any local writer can claim any label.
- Remote delivery is a separate concern with its own configuration. Nothing
  here sends to Telegram, email, or a provider: `bus post` retains a local
  record and `inbox post` appends a local file. Cloud/provider identity
  (provider CLI sign-in, a Locus pin) is established by those tools, never
  by these commands.
