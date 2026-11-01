#!/usr/bin/env python3
"""Restart-after-reboot recovery for tracked launchd fleet services.

Foreground status/apply tool. Probes `launchctl print gui/<uid>/<label>` with
timeouts and, with --apply, kickstarts only registered-but-stopped services
(never `kickstart -k`). Never bootstraps/enables/disables/boots out or kills a
service, never reinstalls plists, never takes executable paths. Monitors
recover before compute; compute starts only under healthy telemetry with no
PAUSE sentinel. HOLD is archived only as an expired recognized recovery hold
under healthy telemetry; all other content is preserved with an explanation.
"""
import argparse, json, math, os, pwd, re, stat, subprocess, sys, time
from pathlib import Path

ROLES = ("memguard", "leader", "orch", "dispatch")   # fixed recovery order: monitor first
MONITORS = frozenset(("memguard",))
# Role→label pairs established by tracked references in this repository:
#   leader  ai.ashlr.oversight — LaunchAgent running `ashlr leader tick`
#            (docs/AUTHORITY.md, src/cli/leader.ts, test/vision-review-leader-310b.test.ts)
#   orch    ai.ashlr.daemon — fleet orchestration daemon
#            (src/core/daemon/service.ts, docs/internal/notes.md recovery log)
# The bridge host's dispatchd and memguard installs are externally managed and
# carry no tracked launchd label here; supply them via --service role=label.
TRACKED_LABELS = {"leader": "ai.ashlr.oversight", "orch": "ai.ashlr.daemon"}
LABEL_PREFIXES = ("ai.ashlr.", "com.ashlr.")          # tracked label namespaces
LABEL_RE = re.compile(r"[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,7}\Z", re.I)
ABSENT_RE = re.compile(r"could not find|not found|no such process|not loaded", re.I)
HOLD_SCHEMA, HOLD_KIND = "ashlr.recovery-hold.v1", "reboot-recovery"
FREE_MIN_PCT, PRESSURE_MAX, SWAP_MAX_GIB = 35, 2, 8.0  # memguard/admission thresholds
TIMEOUT = 15


def valid_label(value):
    """Allowlist check: well-formed reverse-DNS label inside tracked namespaces."""
    return isinstance(value, str) and bool(LABEL_RE.fullmatch(value)) and value.startswith(LABEL_PREFIXES)


class Runner:
    """Real command runner → (rc, stdout, stderr, fault)."""
    def run(self, argv, timeout):
        try:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
            return p.returncode, p.stdout, p.stderr, ""
        except subprocess.TimeoutExpired:
            return -1, "", "", "timeout"
        except OSError as e:
            return -1, "", "", "spawn:" + type(e).__name__


def probe(runner, target):
    """launchctl print → registered/running/pid. Redacted: raw output is never reported."""
    rc, out, err, fault = runner.run(["launchctl", "print", target], TIMEOUT)
    if fault:
        return {"registered": None, "running": False, "pid": None, "detail": "probe " + fault}
    if rc == 0:
        mp = re.search(r"(?im)^\s*pid\s*=\s*(\d+)", out)
        ms = re.search(r"(?im)^\s*state\s*=\s*([a-z ]+)", out)
        pid = int(mp.group(1)) if mp else 0
        state = ms.group(1).strip() if ms else "unknown"
        return {"registered": True, "running": pid > 0 or state == "running",
                "pid": pid or None, "detail": "state=" + state}
    if rc == 113 or ABSENT_RE.search(out + err):
        return {"registered": False, "running": False, "pid": None,
                "detail": "not registered (print exit %d)" % rc}
    return {"registered": None, "running": False, "pid": None, "detail": "print exit %d" % rc}


def telemetry(runner):
    """Mac memory telemetry. Any failed or unparsable read makes the result unknown → unsafe."""
    t = {"freePct": None, "pressureLevel": None, "swapGib": None}
    rc, out, _, _ = runner.run(["memory_pressure"], 10)
    m = rc == 0 and re.search(r"free percentage:\s*(\d+)", out)
    if m:
        t["freePct"] = int(m.group(1))
    rc, out, _, _ = runner.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], 5)
    if rc == 0 and out.strip().isdigit():
        t["pressureLevel"] = int(out.strip())
    rc, out, _, _ = runner.run(["/usr/sbin/sysctl", "-n", "vm.swapusage"], 5)
    m = rc == 0 and re.search(r"used\s*=\s*([\d.]+)\s*M", out)
    if m:
        t["swapGib"] = round(float(m.group(1)) / 1024, 3)
    t["healthy"] = None not in t.values() and t["freePct"] >= FREE_MIN_PCT \
        and t["pressureLevel"] < PRESSURE_MAX and t["swapGib"] < SWAP_MAX_GIB
    return t


def pause_state(runs_dir):
    """PAUSE sentinel: present → paused; unreadable → unknown (treated as unsafe)."""
    try:
        (runs_dir / "PAUSE").lstat()   # lstat: a dangling symlink still pauses (memguard convention)
        return True, "PAUSE sentinel present"
    except FileNotFoundError:
        return False, "no PAUSE sentinel"
    except OSError as e:
        return None, "PAUSE unreadable: " + type(e).__name__


def classify_hold(runs_dir, now):
    """→ (status, detail): absent|stale|active|deliberate|ambiguous. Only a recovery
    hold with a declared, passed expiry is stale; file age alone never proves it."""
    p = runs_dir / "HOLD"
    try:
        if not stat.S_ISREG(p.lstat().st_mode):
            return "ambiguous", "HOLD is not a regular file"
        text = p.read_text("utf-8", "replace").strip()
    except FileNotFoundError:
        return "absent", "no HOLD sentinel"
    except OSError as e:
        return "ambiguous", "HOLD unreadable: " + type(e).__name__
    if not text:
        return "ambiguous", "HOLD is empty; cannot prove a stale recovery hold"
    try:
        doc = json.loads(text)
        if not isinstance(doc, dict) or doc.get("schema") != HOLD_SCHEMA:
            return "deliberate", "unrecognized structured HOLD contents"
        if doc.get("kind") != HOLD_KIND:
            return "deliberate", "recognized schema, non-recovery kind %r" % doc.get("kind")
        expiry = doc.get("expires")
    except ValueError:
        # A bare `reboot-recovery` marker is the recognized kind but declares no
        # expiry; every other unstructured content is a lane/operator hold.
        if not re.fullmatch(r"reboot-recovery", text, re.I):
            return "deliberate", "lane/operator HOLD contents"
        expiry = None
    if not isinstance(expiry, (int, float)) or not math.isfinite(expiry):
        return "ambiguous", "recovery hold declares no expiry; age alone is not stale"
    if expiry > 1e12:
        expiry = int(expiry / 1000)                 # tolerate millisecond epochs
    if expiry <= now:
        return "stale", "recognized %s hold expired at %d" % (HOLD_KIND, expiry)
    return "active", "recognized recovery hold, not stale until %d" % expiry


def release_hold(runs_dir, detail, tele, now):
    """Archive HOLD → HOLD.released-<ts> and write a JSON receipt."""
    archived = os.path.join(runs_dir, "HOLD.released-%d" % int(now))
    os.replace(runs_dir / "HOLD", archived)
    receipts = runs_dir / "recovery-receipts"
    receipts.mkdir(exist_ok=True)
    rp = receipts / ("hold-release-%d.json" % int(now))
    rp.write_text(json.dumps({"schema": "ashlr.hold-release.v1", "releasedAt": int(now),
                              "archived": os.path.basename(archived), "reason": detail,
                              "telemetry": {k: tele[k] for k in ("freePct", "pressureLevel", "swapGib")}},
                             indent=2) + "\n")
    return str(rp)


def recover(role, label, runner, uid, apply, gate):
    """One service. Mutates only via `launchctl kickstart` (no -k) on registered stopped services."""
    s = {"role": role, "label": label}
    if label is None:
        return {**s, "status": "unconfigured",
                "detail": "no tracked label; supply --service %s=<ai.ashlr.*|com.ashlr.*>" % role}
    p = probe(runner, "gui/%d/%s" % (uid, label))
    if p["registered"] is None:
        return {**s, "status": "failed", "detail": p["detail"]}
    if not p["registered"]:
        return {**s, "status": "not-registered", "detail": p["detail"] + "; never bootstrap"}
    if p["running"]:
        return {**s, "status": "running", "pid": p["pid"], "detail": p["detail"]}
    if not apply:
        return {**s, "status": "stopped", "detail": p["detail"] + "; run --apply to kickstart"}
    if gate:
        return {**s, "status": "blocked", "detail": gate}
    rc, _, _, fault = runner.run(["launchctl", "kickstart", "gui/%d/%s" % (uid, label)], TIMEOUT)
    if fault or rc != 0:
        return {**s, "status": "failed", "detail": "kickstart " + (fault or "exit %d" % rc)}
    p2 = probe(runner, "gui/%d/%s" % (uid, label))
    if p2["running"]:
        return {**s, "status": "started", "pid": p2["pid"], "detail": "kickstarted; " + p2["detail"]}
    if p2["registered"]:
        return {**s, "status": "kickstarted", "detail": "fired once; " + p2["detail"]}
    return {**s, "status": "failed", "detail": "kickstart accepted but " + p2["detail"]}


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("subset", nargs="*", metavar="ROLE|LABEL",
                    help="explicit subset of roles (%s) or configured labels" % "/".join(ROLES))
    ap.add_argument("--apply", action="store_true",
                    help="kickstart registered-but-stopped services; release an expired recognized recovery HOLD")
    ap.add_argument("--service", action="append", default=[], metavar="ROLE=LABEL",
                    help="supply a launchd label for a role (ai.ashlr.*/com.ashlr.* only)")
    ap.add_argument("--runs-dir", help="runs state directory (default ~/.ashlr-runs of the uid account)")
    ap.add_argument("--json", action="store_true")
    return ap.parse_args(argv)


def main(argv=None, deps=None, out=None):
    out, deps = out or sys.stdout, deps or {}
    runner = deps.get("runner") or Runner()
    uid = deps.get("uid", os.getuid())
    dep_now = deps.get("now", time.time)
    now = dep_now() if callable(dep_now) else dep_now
    args = parse_args(argv)
    labels = dict(TRACKED_LABELS)
    for item in args.service:
        role, sep, label = item.partition("=")
        if not sep or role not in ROLES or not valid_label(label):
            print("invalid --service %r: expect ROLE=<ai.ashlr.*|com.ashlr.* label>" % item, file=sys.stderr)
            return 2
        labels[role] = label
    wanted = set()
    for item in args.subset:
        if item in ROLES:
            wanted.add(item)
        elif item in labels.values():
            wanted.add(next(r for r in ROLES if labels.get(r) == item))
        else:
            print("unknown role or unconfigured label: %r" % item, file=sys.stderr)
            return 2
    roles = tuple(r for r in ROLES if not wanted or r in wanted)   # order is always monitor-first
    home = Path(deps.get("home") or pwd.getpwuid(uid).pw_dir)
    runs_dir = Path(args.runs_dir) if args.runs_dir else home / ".ashlr-runs"
    tele = telemetry(runner)
    paused, pause_detail = pause_state(runs_dir)
    gate = "compute held: " + pause_detail if paused is not False \
        else ("compute held: memory telemetry unsafe or unknown" if not tele["healthy"] else None)
    services = [recover(r, labels.get(r), runner, uid, args.apply,
                        gate if r not in MONITORS else None) for r in roles]
    hold = classify_hold(runs_dir, now)
    hold_out = {"status": hold[0], "action": "none" if hold[0] == "absent" else "preserved",
                "detail": hold[1]}
    if hold[0] == "stale" and args.apply and tele["healthy"] and paused is False:
        try:
            hold_out.update(action="released", receipt=release_hold(runs_dir, hold[1], tele, now))
        except OSError as e:
            hold_out.update(action="failed", detail="release failed: " + type(e).__name__)
    elif hold[0] == "stale":
        hold_out["detail"] += "; eligible for --apply release once telemetry healthy" \
            if not args.apply else "; preserved: telemetry unsafe or unknown"
    ok = {"running", "started", "kickstarted"}
    complete = all(s["status"] in ok for s in services) and hold_out["action"] != "failed"
    report = {"schema": "ashlr.service-recovery.v1", "at": int(now), "apply": args.apply,
              "runsDir": str(runs_dir), "telemetry": tele,
              "pause": {"present": paused, "detail": pause_detail},
              "services": services, "hold": hold_out, "complete": complete}
    if args.json:
        print(json.dumps(report, indent=2), file=out)
    else:
        print("telemetry free=%s%% pressureLevel=%s swap=%sGiB healthy=%s"
              % (tele["freePct"], tele["pressureLevel"], tele["swapGib"], tele["healthy"]), file=out)
        print("pause: %s" % pause_detail, file=out)
        for s in services:
            print("%-9s %-28s %-14s %s" % (s["role"], s.get("label") or "-", s["status"], s["detail"]), file=out)
        print("hold: %s (%s) %s" % (hold_out["status"], hold_out["action"], hold_out["detail"]), file=out)
        print("result: %s" % ("ok" if complete else "incomplete"), file=out)
    return 0 if complete else 2


if __name__ == "__main__":
    sys.exit(main())
