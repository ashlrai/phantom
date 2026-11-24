# RQ-RESOURCE-LIVE-1: Security package draft

Status: draft for Security review. Nothing here is installed. No agent runs
`install.sh --apply`, and no file in this package replaces a live or pinned
file.

## What is asked

Two things need a decision that an agent lane cannot make.

1. **A new LaunchAgent, `ai.ashlr.resource-live`.** It runs
   `phm usage resource-live --watch` as the operator and keeps
   `~/.ashlr-runs/state/resource-live.json` current. This is a new standing
   process, so it is a new permission.
2. **A merge step in the Eng Ops `ai.ashlr.resource-pool` builder**, and a
   later read of that merged block by the dispatcher. `resource_live_merge.py`
   is the reference for the builder. The dispatcher change is described below
   and is not included as a diff: `dispatchd.py`, `work_market.py` and
   `fleet_controller.py` are pinned and their change needs its own pin.

## What the process does

Each pass reads every allowance through the sources below, in order, and
stops at the first current reading.

| Tier | Source | Used for |
| --- | --- | --- |
| official | Phantom's parsed Claude `/usage` reading (`metrics/claude-quota.json`), the Fable weekly sensor file, the Codex App Server rate-limit read on an explicit pool home, the Devin org API through the existing secrets broker, the Claude API grant store, the Grok runway store, loopback `/v1/models` | Claude weekly, Fable share, Codex personal and CMP, Devin, Claude API credit, Grok, local models |
| own-call | Rate-limit data returned to calls Phantom already made: the Claude `rate_limit_event` store, and the GLM Lite window the dispatcher publishes in `queue/resources.json` | Claude weekly, GLM Lite |
| visible-window | Rendered text of a usage page in the dedicated usage browser profile. Only with `--browser`, which this LaunchAgent does not pass | Claude, Codex personal, Devin, GLM Lite, Gemini |

Devin Flash, Antigravity, Dot, Instinct and Cursor have no supported source
yet. They are written as unverified with nulls.

It writes two places only:

- `<runs>/state/resource-live.json` (mode 0600, replaced by rename), plus a
  `.resource-live.lock` beside it while a pass runs.
- `<runs>/bus/masbot/resource-live-reset-<window>-<kinds>.json` when the reset
  rule fires. That file is a draft for Mason. It names no action an agent may
  take.

## What it does not do

- It does not click a reset, buy credits, or change a plan. The reset rule
  only drafts.
- It does not read a credential, cookie, keychain item, app database or TCC
  store.
- It does not read anything under `~/.codex*`. A Codex pool home is used only
  when `PHANTOM_SENSOR_CODEX_CMP_HOME` or `PHANTOM_SENSOR_CODEX_PERSONAL_HOME`
  names one, and the operator home and any `~/.codex*` path are refused. The
  plist sets neither variable, so Codex stays unverified until Security adds
  them.
- It does not open `state/resource-pool.json`.
- It does not use Accessibility. The desktop Accessibility read of a visible
  window (the OS-1 and MACCU path) is not part of this package. The MACCU TCC
  helper is its own Security pin, and adding it as a third-tier source is a
  follow-up that needs that pin first.

## Files

| File | Purpose |
| --- | --- |
| `ai.ashlr.resource-live.plist.in` | LaunchAgent template. `KeepAlive`, 60 s throttle, no extra environment beyond `HOME`, `PATH`, `ASHLR_RUNS_DIR`. |
| `install.sh` | Dry run by default. `--apply` needs `--pin` equal to the package sha256 it prints. |
| `resource_live_merge.py` | Pure merge for the pool builder, plus `lane_rank()` for a router. Standard library only. |
| `tests/test_resource_live_merge.py` | Merge tests. |
| `tests/test_install.sh` | Dry-run and refusal checks. Writes only under a temp dir. |

## Review steps

```sh
python3 -I -B -m unittest discover -s tests -p 'test_*.py'
bash tests/test_install.sh
./install.sh --phm /absolute/path/to/phm        # dry run, prints the plist and the package sha256
```

If approved, Security runs `./install.sh --apply --pin <that sha256> --phm <path>`.
To remove it: `launchctl bootout gui/$(id -u)/ai.ashlr.resource-live` and delete
`~/Library/LaunchAgents/ai.ashlr.resource-live.plist`. The sidecar can stay or
be deleted; consumers treat a missing or old file as unknown.

## Builder merge

In the `ai.ashlr.resource-pool` builder, before it writes
`state/resource-pool.json`:

```python
from resource_live_merge import merge
document = merge(document, load_json_or_none(runs / "state" / "resource-live.json"), time.time())
```

`merge` adds one key, `live`, and leaves every other key alone. A reading that
is unverified or past its `stale_after` has null values. The `stale` and `stale_over_1h` flags distinguish an expired reading from
one observed over an hour ago; unknown observation times produce a null age flag.
A plan older than one hour is dropped (`live.current` is false), so a stopped reader cannot leave
a stale spend order in force.

## Dispatcher change, for a later pin

The dispatcher can follow the burn-down order with one input:
`lane_rank(pool)` gives each lane's position, lower first. In
`work_market.choose()` that position would sort after the preferred lane and
before `running/target`. Three rules keep the existing behaviour safe:

- A lane missing from the rank keeps its current order. An empty rank changes
  nothing.
- Lane `target`, `floor`, `ceiling` and `hard_cap` from `queue/slots.json` are
  untouched, so a steady-load floor still gets its share.
- A lane whose allowance row says `hold` is already stopped by the existing
  weekly gate or credit hold. The rank does not add a second stop.

## Open questions for Security and Eng Ops

1. Is `bus/masbot/` the right inbox, and is JSON with
   `schema: resource-live.reset-decision.v1` what Masbot reads? No writer for
   that path existed in the repo, so the shape is new.
2. Should the plist set the two Codex pool home variables, and to which paths?
3. Should the agent pass `--browser`? That needs Playwright and a one-time
   sign-in by the operator in the dedicated profile.
