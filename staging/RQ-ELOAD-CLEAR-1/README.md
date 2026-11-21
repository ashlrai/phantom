# RQ-ELOAD-CLEAR-1: load incident e clears too early

## Finding

- `~/.ashlr-runs/bin/self_aware.py` (launchd `ai.ashlr.self-aware`, owned by Eng Ops)
  resolved the outside-load incident (prefix `e`) at 15:28:36 ET on Nov 16 with
  "condition cleared" while load1 was over 100.
- The script is live-only. It is not tracked in `ashlrai/phantom` (`git ls-files`
  finds no `self_aware.py`), and it is not under `contrib/mac/`. The repo
  only consumes the incident filenames it writes (`src/core/autofix/incidents.ts`,
  `docs/AUTOFIX.md`).
- The plist runs the script every 300 s (`StartInterval 300`, no `KeepAlive`).
  Each tick is a new process. Any clear streak has to be stored on disk.
- The live file could not be read from the job sandbox (`Operation not permitted`
  on `~/.ashlr-runs`). The integration below is written against the contract in
  `docs/AUTOFIX.md`, not the live source. Eng Ops must check it against the file.

## Fix

Opening is unchanged: an incident opens when load1 is above 2 x ncpu.

An open `e` incident may clear only after load1 has been below the same
threshold for 2 consecutive samples, with the counted samples at least 60 s apart.

| Sample | Effect |
| --- | --- |
| load1 at or above threshold, NaN, inf, None or a bool | Resets the streak. Does not clear. |
| First below sample | Starts the streak. Does not clear. |
| Below sample under 60 s after the last counted sample | Ignored. Neither counts nor resets. |
| Below sample 60 s or more after the last counted sample | Counts. The second one clears. |
| Gap over 900 s since the last usable sample, or clock moved back | Resets (not consecutive). |
| Missing, corrupt or mismatched state file | Fresh gate. Fails closed: the incident stays open. |

`load_clear_gate.py` is stdlib only. It has no I/O except `load_gate` and
`save_gate`, which read and write one JSON state file atomically.

## Regression

`test_above_below_once_above_again_never_resolves` runs above (150), below once
(20), above again (150), then below once more. It asserts that nothing clears.
The other tests cover spacing, the threshold edge, unusable input, gap handling,
persistence across processes, and fail-closed state handling.

## Integration for Eng Ops (not applied)

Install `load_clear_gate.py` beside `self_aware.py` (or add `bin/` to `sys.path`).
In the `e` clear branch, replace the direct "condition cleared" resolve:

```python
from load_clear_gate import load_gate, save_gate

E_STATE = RUNS / "state" / "load-clear-e.json"   # RUNS = ~/.ashlr-runs
gate = load_gate(E_STATE, threshold=2 * ncpu)     # same threshold as opening
cleared = gate.observe(time.time(), load1)        # load1 from os.getloadavg()[0]
save_gate(E_STATE, gate)                          # every tick, even when not clearing
if cleared and incident_open("e"):
    resolve("condition cleared")
```

Save the state every tick, including ticks that do not clear. Otherwise a
streak resets and the incident never clears.

## Test

```sh
cd staging/RQ-ELOAD-CLEAR-1
HOME=$(mktemp -d) python3 -I -B -m unittest discover -s . -p 'test_*.py' -v
```

## Handoff status

The intended handoff copy at `~/.ashlr-runs/handoff/RQ-ELOAD-CLEAR-1/` was not
written. The job sandbox denies access to `~/.ashlr-runs`. Copy this directory
there from an unsandboxed shell.

No live file was edited. No operator lane installs this copy. Release scripts
and their LaunchAgents were not touched.
