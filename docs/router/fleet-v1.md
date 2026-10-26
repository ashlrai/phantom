# Coding fleet and phone dashboard

Run `phm fleet status --json` on the host to collect a `fleet.v1` snapshot and
write the same JSON atomically to `/workspace/phantom-work/fleet.json`. Set
`PHANTOM_FLEET_PATH` in both the host CLI and remote gateway environment to use
a different private, writable path. Files are owner-only (`0600`); the parent
directory must be private. A failed write exits nonzero. `phm fleet status`
prints the human report; `--legacy` retains the previous operational status
report without refreshing the coding snapshot.

## Manual readings and reset windows

Edit the shared JSON locally to add observations. The CLI preserves the
validated `readings` and `windows` arrays when it refreshes the report:

```json
{
  "readings": [
    {"pool":"codex-cmp","used_pct":20,"at":"2026-10-26T08:00:00Z","source":"manual"},
    {"pool":"codex-cmp","used_pct":30,"at":"2026-10-26T10:00:00Z","source":"manual"}
  ],
  "windows": [
    {"pool":"codex-cmp","start":"2026-10-26T00:00:00Z","reset":"2026-10-27T00:00:00Z"}
  ]
}
```

These are fictional observations and a fictional reset schedule. Use actual
provider readings. Future readings and invalid percentages are rejected. Each
reading carries `age_seconds`. Two increasing readings in the same reset
window establish an observed hourly burn rate; one reading, a reversed counter,
or missing observations leaves the rate and projection unknown. A projection
extends that measured rate from the last reading to reset; it is labelled a
linear estimate with future usage unknown. It is never a new observation.

Windows optionally accept `reset_every_days` and an IANA `timezone`; weekly
wall-clock recurrences follow daylight-saving changes. Without a configured
reset window, the ideal curve and projected landing remain unknown. The Grok
Ultra window comes from the existing scheduler configuration: Sunday November
1, 2026 at 8:21 PM America/New_York, then weekly. Its configured usage is an
**estimate**, separate from manual observations. Old-window usage is never
carried into the next window as a reading.

Canonical pools are `grok-ultra-weekly`, `codex-cmp`, `codex-personal`,
`claude-max`, `devin`, `grok-build`, `cursor`, and `omlx`. Scheduler aliases
`codex-primary`, `codex-secondary`, `claude`, and `local` map to the corresponding
canonical names. Cursor consumes the shared Grok Ultra capacity; it is never
additional capacity or added to the shared total. A Cursor reading describes
its own consumer usage, not the entire shared pool.

## Schema and evidence

The schema identifier is `schema: "fleet.v1"`. Numeric unknowns are JSON `null`;
human and phone reports say **unknown**. Unknown lists are `null`, while a
successfully read empty source can report `[]`. The machine contract is
[`schema/fleet.v1.schema.json`](../../schema/fleet.v1.schema.json).

| Field | Meaning |
| --- | --- |
| `generated_at` | Host snapshot time; the browser also displays snapshot age |
| `readings`, `windows` | Validated observations and per-pool reset metadata |
| `pools` | Usage, reading age, burn, runway, reset, ideal and actual curves, projected landing and optional planner curve |
| `router` | Structured decisions and posterior regret; missing/corrupt sources stay unavailable |
| `agents` | Current task/claim evidence; an unclaimed agent's task is unknown |
| `repos` | Open/recent merged PRs, CI and explicitly attributed ledger costs |
| `coordination` | Active claims, messages and proposed assignments; no private lease capability |
| `sources` | Known, partial or unknown evidence per source |

The router reads `$ASHLR_HOME/router/decisions.jsonl` and `outcomes.jsonl`,
reusing the scheduler's parsers and regret calculation. Router history retains
the newest 1,000 decisions/regret rows and reports partial coverage when capped.
Spend observations live
in `$ASHLR_HOME/router/spend.jsonl`. `ASHLR_HOME` defaults to `~/.ashlr`.
Spend rows can include an explicit paired `repo` and `pr` identity. Older rows
without that identity cannot establish cost for a particular PR. Costs are
reported separately in each pool's units; they are never converted into
dollars without price evidence. Any unknown linked cost makes that PR's cost
unknown. Snapshot collection does not execute work to produce spend evidence.

GitHub collection uses only `gh pr list` with explicit repo, state and structured
JSON fields for the seven AshlrAI repos. Lists are bounded to 100 open and 100
recent merged PRs per repo. `complete: false` discloses the cap or a failed
source; missing authentication, errors and malformed results never mean zero
PRs. CI without check evidence is unknown. No GitHub write is performed.

The parent scheduler currently has no receding-horizon series. When supplied,
`planner.series[pool]` may contain `{at, used_pct}` points; these appear as a
separate planner curve and survive refresh. The measured-rate projection stays
separate. No planner series is fabricated when the parent has none.

## Host coordination

These commands append local advisory events; none starts an agent:

```sh
phm fleet claim --repo ashlrai/phantom --task "Review fleet evidence" --agent codex-cmp --ttl-seconds 3600 --json
phm fleet board --json
phm fleet post --from codex-cmp --to cursor --message "Review is ready" --id review-ready --json
phm fleet inbox --agent cursor --json
phm fleet assign --repo ashlrai/phantom --task "Review fleet evidence" --to cursor --json
```

Keep the returned `claim.id` and private `lease` receipt. Release with
`phm fleet release <claim-id> --agent codex-cmp --lease <lease>`; hand off with
`phm fleet handoff <claim-id> --agent codex-cmp --lease <lease> --to cursor`.
Handoff rotates the lease: deliver the new receipt locally to the successor.
An old holder cannot release the successor's claim.

The private append-only ledger defaults to
`$ASHLR_HOME/fleet/coordination.jsonl`; override with
`PHANTOM_FLEET_LEDGER_PATH`. Claims and messages default to a one-hour TTL,
with a seven-day maximum. Expired claims disappear from the read-only board
and are recorded as reaped on the next successful mutation. Normalized duplicate
claims and duplicate message IDs are refused under the existing local store
lock. Corrupt, truncated or unsafe files fail closed. `assign` records only a
proposal with `executionAuthorized: false`.

## Phone access and security

Use the existing [remote phone setup](../REMOTE-PHONE.md). After Access sign-in
and passkey pairing at `/verse/m/`, open `/fleet/` on that same remote origin.
The page polls `GET /api/fleet` every 30 seconds. Refresh the host snapshot on
the desired schedule; a phone poll reads the shared file and does not run `gh`,
write a snapshot, or dispatch work. If the shared path is unavailable, the API
returns a generic 503 and the page explains the stale/unavailable evidence.

`/fleet/`, its two assets, and `/api/fleet` require the existing Access assertion
and a live paired-device session. Expired or revoked sessions stop access.
The listener still binds only `127.0.0.1`. No fleet write endpoint, arbitrary
file route, new server, new auth system or public bind is added. Fleet routes
reject query parameters and write methods. JSON is projected through an
allowlist and scrubbed for token shapes, known credentials and environment
values; errors, auth file contents and raw CLI output never enter the contract.
The page inserts source text as text, never HTML, and constructs PR links from
validated repository/PR identity.

Scheduler PostHog configuration remains opt-in. Only an enabled configuration
with a host and API key emits the existing `phantom_pool_burndown`,
`phantom_grok_ultra_runway`, and `phantom_pool_value_per_dollar` event names.
Fleet events contain numeric pool measurements and fixed labels, never task,
message, repository, person or credential text. Dollar-value fields stay null
without dollar pricing. No telemetry is emitted by remote reads.
