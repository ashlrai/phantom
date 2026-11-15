# Stigmergic coordination

Agents on one machine coordinate through the environment, not through
messages. Phantom leaves *markers* — small private JSON files under
`<ashlr home>/stigmergy/` — that any agent can read: which work items are
claimed, who holds them, when the holder last reported progress, and where
the resumable state lives. A stalled agent's marker expires and evaporates;
another agent claims the key, reads the saved checkpoint and continues the
work. Markers coordinate; they grant no execution authority, merge
permission, or publish rights.

```sh
phm trail list --json
```

## Layout

```text
~/.ashlr/stigmergy/            # or $ASHLR_HOME/stigmergy (mode 0700)
  claims/<sha256(key)>.json    # one marker per claim key (0600)
  checkpoints/<sha256(key)>.json   # saved resumable state for the key (0600)
```

File names are the SHA-256 of the claim key, so every agent computes the
same path for the same work item. The checkpoint slot is deterministic too:
a released or expired claim's saved state survives the marker and attaches
to the next claimant automatically.

## Claim keys

Markers use the [Agent Bus v2](AGENT-BUS.md) claim grammar:

```text
repo:<owner/name>   path:<owner/name>:<glob>   queue:<queue id>   pr:<owner/name>#<n>
```

Overlap follows the bus rule: a `repo:` claim covers every `path:` claim in
that repo, path globs overlap by literal prefix, and `queue:`/`pr:` keys
match themselves only.

## Marker record

```json
{
  "version": 1,
  "claimKey": "repo:example/project",
  "owner": "job-123",
  "jobId": "job-123",
  "tokenHash": "<sha256 of the claim token>",
  "leaseMs": 600000,
  "leaseUntil": 1762640400000,
  "heartbeatAt": 1762640100000,
  "note": "parser done; 3 tests red",
  "worktree": "/abs/path/to/worktree",
  "createdAt": 1762640100000,
  "updatedAt": 1762640100000
}
```

`version`, `claimKey`, `owner`, `tokenHash`, `leaseMs`, `leaseUntil`,
`heartbeatAt`, `createdAt` and `updatedAt` are required; `jobId`, `note` and
`worktree` are optional. Markers are validated strictly — unknown fields,
malformed values and secret-shaped text are refused rather than repaired.
The claim token is shown once at claim time; the file carries only its
SHA-256 hash, and public views never include either. Mutation (beat,
release, save) requires the token, compared against the hash in constant
time.

## Lifecycle

```sh
phm trail claim repo:example/project --owner job-123 --job job-123 \
  --lease-ms 900000 --note "starting" --worktree /abs/worktree --json
phm trail beat repo:example/project --token <hex> --note "3 tests red"
phm trail save repo:example/project --token <hex> --checkpoint handoff.json --worktree /abs/worktree
phm trail release repo:example/project --token <hex> --outcome released
```

- `claim` creates the marker atomically — at most one claimant wins the
  name. A live overlapping marker yields `status: "conflict"` (exit 3) with
  the holder's public view: key, owner, lease end, heartbeat age, note and
  worktree. Lease bounds match the bus contract (1 ms–1 h; default 10 min).
- `beat` is the progress heartbeat: it refreshes `heartbeatAt`, extends the
  lease, and updates the public `note`. Beating an expired claim is refused
  (exit 4, `expired`) — the agent must re-claim and accept that a takeover
  may already have happened.
- `save` writes an authored [agent checkpoint](AGENT-CHECKPOINT.md) into the
  claim's deterministic slot. With `--worktree` it appends the current HEAD
  and porcelain status as evidence; without it the validated handoff is
  stored as authored. Only the live holder may save.
- `release` removes the marker (`released` or `completed`). The checkpoint
  slot deliberately survives: it is the resumable partial state the next
  agent picks up.
- `list` prints every marker, live first then expired, freshest heartbeat
  first, plus a count of unreadable markers.
- `show` prints one marker's public view (`unknown-claim` when absent).
- `resume` prints the marker and the full saved checkpoint — the pickup
  path for stalled work. It succeeds on expired markers: expiry is the
  signal that the holder stalled, not that the state vanished.
- `sweep` evaporates expired and unreadable markers and removes orphaned
  checkpoint slots older than seven days (`--checkpoint-days` to tune).
  A live claim's checkpoint is never swept.

Exit codes: `0` ok, `2` usage or validation error, `3` claim conflict, `4`
mutation refused (`unknown-claim`, `bad-token`, `expired`, `lost-race`), `1`
unexpected failure. Every verb accepts `--json`.

## Reading the environment

A fresh agent joining a machine runs `phm trail list` and sees the world as
it is: live work with fresh heartbeats, stale work whose `heartbeatAgeMs`
has outgrown its lease, and expired markers awaiting pickup. `resume` on an
expired key returns the last saved goal, done/next lists and evidence —
including the worktree path and its recorded Git state — so the agent
inspects the tree and continues instead of restarting. Claims are advisory
between cooperating agents, exactly as in the bus contract: nothing here
blocks a merge, a publish, or a force of will.

## Corruption and races

Markers are published create-exclusively; a corrupt or unparseable marker
is treated as evaporated — acquisition removes it, `list` counts it under
`unreadable`, and `sweep` counts it under `removedClaims`. Mutation writes are atomic (temp file +
rename) and confirmed by re-reading the stored hash; a holder that loses a
microsecond race to a takeover sees `lost-race` rather than silently
overwriting the winner's marker. Everything lives in a private 0700
directory owned by the current user; markers are mode 0600.
