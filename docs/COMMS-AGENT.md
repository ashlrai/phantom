# Comms agent

The Comms role sits under the Leader. It triages email, iMessage and LinkedIn:
classify, summarize, archive bulk and bot mail, and draft replies. It never
deletes mail. A delivered reply resolves its inbox message into the archive,
so pending depth counts only mail still awaiting a reply and a later pass
never resends an answered message. The router and its bandit choose the lane
from the lanes that are actually available. The role names no lane and does
not require Grok. When Grok is one of the available lanes, the router may
select it.

This role reuses the channel adapter interface (`ChannelAdapter`) and the
registered bus and handoff adapters. It does not open a second transport.
LinkedIn is delivered only by an official API or a sanctioned connector that
the caller supplies. Scraping is refused.

## Send policy

The policy is code, not prompt text. A prompt cannot approve a recipient.

- A send requires an owner standing approval for that exact transport and
  recipient. The file is `~/.ashlr/comms-agent/standing-approvals.json`.
  `--dir`, `ASHLR_RUNS_DIR` and `$HOME` do not select it. The path uses the
  account home from the passwd entry. The file must be a regular file owned
  by the current user, mode 0600, and not a symlink. The mode and owner are
  read from the file handle opened with no-follow.
- Everyone else, including a novel recipient, becomes a draft for the owner.
  Email drafts are also copied into `phm drafts` so the desktop drafts card
  can show them. Every draft is recorded once per unique reply on the local
  owner thread; a delivered reply resolves its draft to `sent` — every send
  leaves that mark, not only one that was once pending — and resolves the
  inbox message into the archive without resending. Two inbox rows that draft
  the same unique reply in one pass also deliver once: the second resolves on
  the first's sent mark. Pending drafts list in
  `phm comms-agent drafts` and the `phm comms inbox` drafts
  source (a Comms email draft already mirrored into `phm drafts` lists only
  there, so one pending reply is one item). `phm comms-agent drafts
  --status sent` (or `all`) reads the resolved half of the same store —
  delivered replies with their `resolvedAt` stamp — and `--transport`
  narrows either slice to one channel; the default stays pending-only.
  `--to` keeps only drafts addressed to one exact recipient — the same
  exact transport+recipient pairing standing approvals apply — `--contains`
  keeps drafts whose scrubbed subject or body carries the needle as a
  case-insensitive substring, `--since`/`--before` keep drafts whose
  `createdAt` stamp falls inside one [since, before) window on the shared
  `15m|2h|1d|ISO|epoch` grammar (never `resolvedAt`, and a record whose
  `createdAt` does not parse drops out rather than guessing a time),
  `--id` keeps only the draft whose id strictly equals the value, and
  `--limit` caps the page oldest-first while `matched` still reports the
  true filtered total; every filter applies to the `drafts` verb only.
- KILL and the comms pause refuse every send. Both are read from the account
  home (`os.userInfo().homedir`), so a process with a relocated `$HOME` still
  sees `~/.ashlr/KILL` and `~/.ashlr/comms/pause.json`.
- Every completed send is appended to the send log once its `sent` draft
  record has landed; a send-log store failure cannot rewrite a completed
  send into a resend. The log stores a Phantom Secrets handle (`phm_…`) when
  one was named, never a credential value.
- A raw credential is refused.

## Commands

```sh
phm comms-agent status --json
phm comms-agent run --lanes claude,local --json
phm comms-agent drafts --json
phm comms-agent drafts --status sent --transport email --json
phm comms-agent drafts --to known@example.com --contains "invoice" --since 2h --json
```

`--lanes` is the candidate set. Omit it and the run reports no lane rather
than picking one. The run report lists each inbox message's mail class and
scrubbed one-line summary under `summaries`, and the same per-message
decisions are appended to the run journal `status` reads. `--dir` selects
an isolated runs directory. `drafts`
takes `--status pending|sent|all` (default `pending`), `--transport`
(one of the Comms transports), `--to`, `--contains`, `--since`, `--before`,
`--id` and `--limit` (1–200) to narrow the read; the filters apply to the
`drafts` verb only, and `ashlr_comms_agent_drafts` accepts the same set.

`status` reports the pending inbox depth as `inbox`: a real count of
messages still awaiting a reply — unanswered mail only, since a delivered
reply resolves its message into the archive — or `null` when the inbox file
cannot be read — an unreadable store is unknown, never reported as an empty
inbox. `drafts`, `sendsLogged` and `adapters` follow the same rule: a real
count or list, or `null` when the drafts log, send log or channel registry
cannot be read. `standingApprovals` reports the trust verdict `run` applies
before any send — `accepted`, the fixed `reason` (`ok`, `missing`,
`malformed`, `symlink`, `mode`, `owner`, `not-file`) and the counts of
granted approvals and owner identities. The approval and owner lists
themselves never leave the file: recipients and owners are handles.
`standingApprovals` is `null` when the owner file cannot be read at all —
the verdict is unknown, never guessed. `lastRun` reports the last pass that
completed, read from the run journal `run` appends to `runs.jsonl`: `source`
is `missing` when no pass ever completed (a verified-empty journal),
`available` when a record was read — `run` then carries the completion
time, lane, triage depth, per-status send outcome counts and the pass's
per-message triage decisions (`summaries`: each inbox message's id, mail
class and scrubbed one-line summary, so the journal says which mail was
kept, archived or drafted — `null` on records written before the field
existed, since those passes recorded counts only and the decisions are
unknown, never reported as none) — and
`unavailable` when the journal cannot be read or holds no readable record,
so a pass may have run and the answer stays unknown rather than reported as
never-ran. A pass that fails mid-flight appends nothing, so a stale `at` is
itself the signal that passes are not completing.

MCP tools: `ashlr_comms_agent_status`, `ashlr_comms_agent_drafts`, and
`ashlr_comms_agent_run`.

The inbox, archive, send log, owner-thread notices and run journal live under
`~/.ashlr-runs/comms-agent/`
(or `--dir`). Those files must not be symlinks. The inbox is rewritten
atomically. Standing approvals stay at the fixed owner path:

```json
{ "owners": ["you@example.com"], "approvals": [{ "transport": "email", "recipient": "known@example.com" }] }
```

A missing or malformed file grants no approvals.
