# CONTRACT-AUTOFIX

Status: source-complete. `phm autofix` does not sign, publish, delete tags,
delete drafts, edit `router-queue.md`, or call a model.

## Input

Eng Ops writes `~/.ashlr-runs/bus/core/INCIDENT-<key>.md`. Autofix parses
`<key>` from the filename. The key matches `^[a-z0-9._-]{1,96}$`. The file
body is not read and is not copied into commands, arguments, or the environment.

`INCIDENT_FIXER_TABLE` is the only prefix map:

- `a` release-stuck-draft
- `b` launchd-crashloop
- `d` stuck-lane
- `e` outside-load
- `g` autorun-hold (detect-only)

## Output

Each acted key appends one line to `~/.ashlr-runs/ledger/incidents.jsonl`:

```json
{"key":"e_load","status":"refused","reason":"refuse-below-target","ts":"2026-11-16T18:00:00.000Z"}
```

`status` is `fixed`, `failed`, `intentional`, or `refused`. A newer published
release and a lane target of 0 are `intentional`. An autorun hold is `refused`
with reason `detect-only-security`.

Action detail is appended to `~/.ashlr-runs/ledger/autofix.jsonl` with `ts`,
`fixer`, `target`, `action`, `before`, `after`, and `result`.

## Exported behavior

- `parseIncidentFilename` accepts only `INCIDENT-<key>.md`.
- `launchdLabelFromKey`, `laneFromKey`, and `tagFromIncidentKey` return a
  validated identifier or null. They do not return file body text.
- `assessCrashRate` requires a fresh sample and a second sample at least 60
  seconds earlier. The recent delta must be positive and the hour delta must
  be greater than 20.
- `residentAdmissionBlocksDisable` is true only for an admitted active grant
  whose service line says `ai.ashlr.daemon` is running.
- `operatorStartRecent` is true when the plist or a `.rollback.*` sibling is
  newer than 15 minutes, or the plist mtime is unknown.
- `newerReleasePublished` is true when a higher semver is not a draft.
- `runAutofix` returns exit 3 when `~/.ashlr/KILL` exists and performs no action.

The tick is idempotent: a key already marked `fixed` or `intentional` is not
acted on again. `fixed` and `intentional` are not written twice.
