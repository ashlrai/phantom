# Fleet report-export: scheduled EO reports without a model

`phm fleet report-export` builds the 7:30 AM and 8:00 PM ET fleet reports as
files on this Mac:

- `~/.ashlr-runs/export/report-0730.md`
- `~/.ashlr-runs/export/report-2000.md`

Each report is assembled deterministically — no LLM and no Grok anywhere in
the path — from the world model (`phm world --json` snapshot), the recorded
jobs ledger (`~/.ashlr-runs/metrics/jobs.jsonl`, trailing 12 h), the leader's
in-force intents (operator directives, self-directives, open goals, pending
inbox proposals, queue next-up) and a bounded `gh run list` read for Actions
run evidence. The desktop Leader panel reads the files; Eng Ops / EO routines
only relay them, so the files stay the source of truth when relays are down.

## What you get

Each report starts with a marker comment naming its schema, slot and the
America/New_York day it covers, then:

- World: per-lane used/limit/remaining, burn, runway and required pace;
  roster, claims, queue, CI, releases, bottlenecks, human steps, outcomes
  per repo, blind spots.
- Growth: launches, finishes (empty count), publishes, merges, token totals
  and per-lane counts for the trailing 12 h, from the recorded ledger.
- Evidence: PR URLs recorded as published or merged in the window, plus
  Actions run ids and URLs from `gh run list` per measured repo (bounded:
  at most 4 repos, 3 runs each).
- Intents: operator directives in force, leader self-directives, open goal
  count and titles, pending proposals, and the per-lane queue next-up.

Unknown readings stay unknown. A missing world snapshot, an unreadable
ledger, an absent `gh` or a partially read intents store produces an explicit
`unavailable`/`incomplete` line — never a zero. All rendered text passes
through the secret scrubber; no tokens, chat ids or addresses can appear.

## Scheduling

The Mac dispatcher (`contrib/mac/dispatchd.py`, the LaunchAgent-free tick)
spawns `~/.ashlr-runs/bin/report-export.sh` once each slot's build time has
passed — 07:25 ET for the 07:30 report, 19:55 ET for the 20:00 report. The
report's own `day=` marker is the idempotence: once today's file exists the
slot is skipped. A failed build retries on later ticks, at most 3 launches
per slot per day (`.report-<slot>.tries` stamps bound it). The kill switch
is `~/.ashlr-runs/export/REPORTS_OFF`.

`report-export.sh` ships through the normal machinery path: it is a `managed`
entry in `fleet/manifest.json`, so `python3 fleet/sync.py` installs it under
`~/.ashlr-runs/bin` like every other managed file. Security adoption: the
schedule lives in `dispatchd.py`, which is a pinned file — a repo change to
it takes effect only after Security reviews, re-pins and installs via
`contrib/mac/install.sh`. No operator lane installs the repo copy over the
live one; the wrapper itself installs through `fleet/sync.py` with the other
managed machinery.

## Copy-paste

```bash
phm fleet report-export --json              # build every slot due today
phm fleet report-export --slot 0730 --json  # build just the morning report
phm fleet report-export --slot 2000 --force # rebuild today's evening report
```

`--slot auto` (default) writes every slot whose build time has passed today
and whose report does not already carry today's marker. A named slot builds
that slot now, still day-gated unless `--force`. `--json` prints
`{ schema, day, entries }` where each entry is
`{ slot, path, outcome, reason, bytes }` with outcome `wrote`, `skipped`
(`already-built-today`) or `failed`; report bodies are never printed.

## Kill switch and fixtures

- `touch ~/.ashlr-runs/export/REPORTS_OFF` stops the scheduled builds; remove
  it to resume. Hand runs still work.
- `REPORTS_TEST` (a sentinel file under `~/.ashlr-runs`) plus the
  `REPORTS_NOW_EPOCH` env var pin the dispatcher's schedule clock for tests.
