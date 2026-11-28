# CRUISE-1: per-node cruising speed

Goal (Mason, Nov 24 2:29 AM ET): every node holds a steady top speed. As many sessions as the
node can carry, RAM and CPU used, no stalls, no overloads, no trip-and-pause.

Pure stdlib, Python 3.9+. Tests: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest contrib/cruise/tests/test_cruise.py`.

## Pieces

| module | what |
|---|---|
| `sensors.py` + `sensors_macos.py`, `sensors_linux.py`, `sensors_windows.py` | OS-sensor interface ([OS-SENSOR-INTERFACE.md](OS-SENSOR-INTERFACE.md)); macOS first, Linux implemented, Windows stub that reports unknown |
| `controller.py` | OS-neutral closed-loop AIMD controller with learned limits |
| `shed.py` | one victim per decision: lowest learned value (lane merges per launch), newest first |
| `capacity.py` | fleet-owned versus foreign load split and the corrected headroom formula |
| `watchdog.py` | runaway-daemon detector (alert only), per-job RSS caps for our own groups, zombie report |
| `markers.py` | Spotlight markers in git-ignored dirs only |
| `profiles.py` | per-node priors by RAM class and form factor (8 GB MBP, 16 GB Air fanless, large, generic) |
| `heartbeat.py` | per-node heartbeat: host, OS, arch, phm/ashlr paths and versions, service units, memory/CPU, tailnet peers |
| `runner.py`, `__main__.py` | ashlr-runs integration: `python3 -m cruise tick / sample / baseline / report` |
| `metrics.py` | before/after numbers from ashlr-runs files |

## Control loop

Each tick (launchd every 60 s):

1. One OS-sensor sample. Indicators: memory-pressure score, compressed-memory growth, swap growth,
   swap-out rate, load per core, thermal state, and the OS's own pressure level.
2. Level indicators (pressure score, load per core) are judged against a learned saturation limit,
   because using RAM and CPU is the goal. Rate indicators (compressed and swap growth, swap-outs)
   are the leading signs of the knee and are judged as robust z against a healthy baseline that only
   learns on healthy ticks.
3. Zone: ok, warn, danger, or unknown (no data: hold, never raise).
4. ok with work queued and the target binding: additive increase by a learned step up to a ceiling
   just under the learned knee; after a learned dwell at the ceiling, probe +1 so the knee keeps
   being re-measured.
5. warn: stop admitting; record the knee only when fleet sessions own the pressure.
6. danger: multiplicative decrease by a learned beta, scaled by the fleet-owned share of the
   pressured resource, and shed ONE session per tick. When foreign processes own the pressure
   (fseventsd tonight held 22 GB and 100 to 239% CPU) the action is `hold_foreign`: capacity is
   reduced, no fleet work is shed, and the knee is not lowered.
7. Feedback: a later bad event (a memguard PAUSE for swap growth, free memory or memguard-v2 level)
   with no warning before it tightens thresholds and boosts the weight of the indicators that led;
   transient danger relaxes them; failed probes lengthen the dwell; a shed that did not relieve
   pressure raises the fleet-share bar; and so on. Every one of these moves is logged with a reason.

memguard stays untouched as the last-resort backstop under the controller.

## Shadow mode, then cutover

`ai.ashlr.cruise-shadow` writes `~/.ashlr-runs/metrics/cruise-shadow.jsonl`: each tick has the
controller's zone, action, target and shed choice next to dispatchd's actual running, target,
admission reason and pause state, plus the fleet/foreign split and the corrected headroom. It also
writes `queue/cruise-decision.json`. Nothing is enforced.

Cutover is the CRUISE-1 Security package (dispatchd gate): dispatchd reads the decision only when
`~/.ashlr-runs/CRUISE_ENFORCE` exists, the decision is fresh, and KILL is absent; otherwise its own
logic runs unchanged.

## Indexing and FSEvents (researched Nov 24 2026)

- FSEvents has no per-directory exclusion. `.fseventsd/no_log` is honoured only at a volume root
  (Apple File System Events Programming Guide, "Preventing File System Event Storage").
  The sanctioned no-sudo route is a separate volume for worktrees: an APFS sparse image created and
  attached by the user with `hdiutil`, with `.fseventsd/no_log` and `.metadata_never_index` at its root.
  That is a worktree move and is proposed, not done.
- Spotlight: `.metadata_never_index` inside a folder is no longer honoured on recent macOS. A folder
  named `*.noindex` or a dot-prefixed folder is. The marker is still dropped (cheap, honoured at
  volume roots and on older releases) but only where git already ignores the path, so clean-tree
  gates never see it. Writes need `~/.ashlr-runs/CRUISE_MARKERS_APPLY`.
- The real fix for new worktrees is a `.noindex` (or dot-prefixed) worktree container. See
  handoff/PCEB-15 notes.

## Fixed constants (could not be made dynamic, or must not be)

Hard limits, fixed by rule: fleet KILL, signing, secrets, no new spend, DISKGUARD100G. memguard and
PAUSE are untouched.

Safety rails on learners (bounds, not set points): `RAILS` in controller.py (step >= 1, beta 0.5..0.95,
margin 0.02..0.5, dwell 2..1440 ticks, z_warn 0.5..50, z_danger 0.75..100, indicator weight 0.25..4),
z_danger >= 1.2 x z_warn, watchdog z_alert 2..100, sustain 2..60, warm 3..1440 samples, min RAM share 0.1%..20%, headroom 1.1..4, fleet_share_min 0.05..0.95.

Learning-rate shapes: nudge factors (x1.25, x0.5, x0.95, x1.02, x1.5, x0.9, x0.85, x1.03, x1.1, x1.05),
knee blend weights 0.3 and 0.2, limit blend 0.5, baseline horizons (240 samples controller,
1440 watchdog), 0.99 quantile for job RSS.

Cadences: launchd interval 60 s, marker scan hourly, heartbeat every 300 s, version re-read hourly,
staleness cut 4 x learned interval, alert cooldown start 900 s (doubles while persisting).

Provider normalisation: macOS thermal bands from CPU_Speed_Limit (100 / 70 / 40), Apple pressure
level map 1/2/4, watchdog cold-start daemon priors, the 50%-of-a-core floor for CPU runaway checks,
RSS kill grace max(5 s, interval / 6), fair-share floor 90% of RAM per target session, 0.995 host quantile for the "big process" bar.

Priors (starting points only, all learned after): profiles.py and `DEFAULT_PRIORS`.
