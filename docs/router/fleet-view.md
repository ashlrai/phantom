# fleet-view.v1: one live view for humans and agents

`phm fleet view` renders the live fleet projection in the terminal; the same
document is served at `GET /api/verse/fleet/view` (the workbench family and the
remote phone page read it there) and emitted as JSON with `phm fleet view --json`.

```
phm fleet view [--json] [--once] [--interval <ms>]
```

- `--json` prints the `fleet-view.v1` document and exits (no TTY needed).
- `--once` (or any non-TTY stdout) renders one frame and exits.
- Interactive use enters the alt screen, refreshes every 2 s
  (`--interval`, 250-30000 ms), and quits on `q`, Esc or Ctrl-C. `r`
  refreshes immediately.

## What the view shows

- **Agents**: every running job: id, lane, account, repo, elapsed, tokens.
- **Accounts**: one resource bar per account: weekly used %, remaining %,
  credits, reset time, burn rate %/h and projected exhaustion (`out in`).
- **Queue**: depth, running count, jobs on record, per-lane running/queued.
- **Throughput**: merged/completed, merge rate, reverts, latest merge PRs.
- **Impact**: per-lane impact scoreboard with a fleet total when every
  merged job carries a measurement.
- **Host**: memory and swap bars.
- **Agent map**: running and queued work grouped by account.
- **Sources**: per-source state marks (`·ok ~partial -missing !invalid
  ✕unsafe`), including whether the status overlay's hash bound the jobs
  bytes and which resource source fed the account bars.

`null` in the JSON (and `-` in the TUI) always means unknown; nothing is
fabricated as zero.

## Sources

| Section | Source |
|---|---|
| queue, agents, lanes, throughput, impact | `~/.ashlr-runs/queue/jobs.jsonl` + `status.json` (see below; `$ASHLR_RUNS_DIR` relocates the root) |
| accounts | `resource.v1` at `$ASHLR_RESOURCE_PATH` or `<runs>/resource.json` when present; the manual `<runs>/fleet.json` (`$PHANTOM_FLEET_PATH`) until the usage source lands |
| pause | the shared kill-switch sentinel (`~/.ashlr/KILL`) |
| host | OS memory (`os.totalmem`/`freemem`) plus `sysctl vm.swapusage` on macOS or `/proc/meminfo` on Linux |

## Router queue interchange (schema version 1)

`jobs.jsonl` holds one JSON object per job:

```json
{"schemaVersion":1,"id":"RQ-1","lane":"codex-cmp","tier":"frontier","outcome":"running","tokens":812345,"startedAt":"2026-02-13T14:10:00.000Z","repo":"ashlrai/phantom","title":"optional label"}
```

Required identity: `schemaVersion:1`, `id`, `lane`, `tier`. Optional fields:
`outcome` (`queued|running|merged|empty|failed|cancelled`), `tokens`,
`startedAt`, `mergedAt` (canonical `...Z` instants), `pr`
(`owner/repo#number`), `reverted`, `impact`, `repo`, `title`.

`status.json` is a measurement overlay:

```json
{"schemaVersion":1,"jobsSha256":"<sha256 of the exact jobs.jsonl bytes>","jobs":[{"id":"RQ-1","tokens":845000}]}
```

The overlay applies only when `jobsSha256` equals the hash of the jobs file
as read: a torn writer pair degrades to `partial` and the log rows still
serve. Overlay rows may only replace measurement fields; identity fields
and terminal facts (a merged job's outcome or PR, a reverted flag already
true) cannot be contradicted. Merge-evidence invariants are enforced on
the combined rows: merge-only fields on a non-merged job, a merge before
its start, and PRs claimed twice are dropped as rows.

## Manual fleet.json (until resource.v1 lands)

`~/.ashlr-runs/fleet.json` carries hand-recorded readings and account
windows:

```json
{
  "readings": [{"pool":"codex-cmp","used_pct":60,"at":"2026-02-13T15:00:00.000Z","source":"manual"}],
  "windows":  [{"pool":"codex-cmp","reset":"2026-02-20T00:00:00.000Z","reset_every_days":7,"timezone":"UTC"}]
}
```

Two increasing readings inside one window give a measured burn rate and a
projected exhaustion; a single reading leaves those fields null. Weekly
recurrences follow the configured timezone through DST. When
`resource.v1` (written by the usage-source collector) is present it wins;
per-account `source` says which one fed each bar (`resource.v1`,
`estimate`, `manual`, `unknown`).

## Remote access

`GET /api/verse/fleet/view` is on the phone gateway's read allowlist:
authenticated devices get the same document, mutations are denied (405 on
the hub route, unlisted on the gateway), and the response is bounded and
secret-scanned like every other remote read. The document's fields are
validated identifiers, bounded titles and numbers: no paths, environment
values or credential-shaped text ever enter it.
