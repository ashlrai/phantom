"""Per-node heartbeat (CRUISE-1, Eng Ops 2:47 ET): what this node IS, from its own readings, so
profiles are learned per node and never assumed from a hostname guess.

Payload (schema ashlr.node-heartbeat.v1): host, OS family/version/arch, every phm and ashlr
executable on PATH (plus ~/.local/share/ashlr/current) with its --version, fleet service units
(LaunchAgents / systemd --user / schtasks via the OS-sensor interface, unparseable definitions
flagged), memory and CPU readings, the cruise profile and learned knee, and tailnet peers
(tailscale status --json with TAILSCALE_BE_CLI=1; hostnames and online flags only).
Written locally to ~/.ashlr-fleet/nodes/<host>.json. fleetlease.py's own heartbeat(extra=...)
is the cross-node transport over the lease repo; observed.json is fleetlease's private observer
clock and is never written here (a second writer would race its _save)."""
from __future__ import annotations

import json
import os
import platform
import socket
import time

VERSION_TTL_S = 3600   # re-run `--version` at most hourly (node startup is expensive under load)


def _paths_named(names):
    seen, out = set(), []
    for d in (os.environ.get("PATH") or "").split(os.pathsep) + [os.path.expanduser("~/.local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]:
        for n in names:
            p = os.path.join(d, n)
            if p in seen: continue
            seen.add(p)
            if os.path.isfile(p) and os.access(p, os.X_OK): out.append(p)
    cur = os.path.expanduser("~/.local/share/ashlr/current")
    if os.path.exists(cur): out.append(cur)
    return out


def _pkg_version(real):
    d = real if os.path.isdir(real) else os.path.dirname(real)
    for _ in range(4):
        pj = os.path.join(d, "package.json")
        if os.path.isfile(pj):
            try:
                with open(pj) as f: j = json.load(f)
                if j.get("version"): return str(j["version"])
            except (OSError, ValueError):
                return None
        d = os.path.dirname(d)
    return None


def tailnet(runner):
    for b in ("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/usr/bin/tailscale"):
        if not os.path.exists(b): continue
        old = os.environ.get("TAILSCALE_BE_CLI"); os.environ["TAILSCALE_BE_CLI"] = "1"
        try: out = runner([b, "status", "--json"], 10)
        finally:
            if old is None: os.environ.pop("TAILSCALE_BE_CLI", None)
            else: os.environ["TAILSCALE_BE_CLI"] = old
        if not out: return {"binary": b, "ok": False}
        try: d = json.loads(out)
        except ValueError: return {"binary": b, "ok": False}
        peers = [{"host": p.get("HostName"), "dns": (p.get("DNSName") or "").rstrip("."), "os": p.get("OS"), "online": p.get("Online"),
                  "last_seen": p.get("LastSeen")} for p in (d.get("Peer") or {}).values()]
        me = d.get("Self") or {}
        return {"binary": b, "ok": True, "self": {"host": me.get("HostName"), "dns": (me.get("DNSName") or "").rstrip(".")}, "peers": sorted(peers, key=lambda x: x["host"] or "")}
    return {"ok": False, "reason": "tailscale binary not found"}


def build(sensor, cache=None, now=None, cruise=None):
    now = now or time.time()
    cache = cache if cache is not None else {}
    s = sensor.sample()
    vers = cache.setdefault("versions", {})
    bins = []
    for p in _paths_named(("phm", "ashlr")):
        real = os.path.realpath(p)
        c = vers.get(real)
        if not c or now - c.get("ts", 0) >= VERSION_TTL_S:
            v, how = _pkg_version(real), "package.json"
            if v is None:
                exe = os.path.join(real, "bin", "ashlr") if os.path.isdir(real) else real
                out = sensor.run([exe, "--version"], 15) if os.path.isfile(exe) else None
                v, how = ((out or "").strip().splitlines() or [None])[0], "--version"
            c = {"ts": now, "version": v[:80] if v else None, "source": how}
            vers[real] = c
        bins.append({"path": p, "realpath": real, "version": c["version"], "source": c.get("source")})
    svc = None
    try: svc = sensor.services()
    except Exception: svc = None
    return {
        "schema": "ashlr.node-heartbeat.v1", "ts": now, "host": socket.gethostname(),
        "os": {"family": sensor.os_name, "version": sensor.os_version(), "arch": platform.machine(), "model": s.model},
        "cpu": {"ncpu": s.ncpu, "load1": s.load1, "load_per_core": s.load_per_core, "thermal": s.thermal},
        "memory": {"total_bytes": s.mem_total_bytes, "free_pct": s.free_pct, "pressure_level": s.pressure_level,
                   "swap_used_bytes": s.swap_used_bytes, "swap_total_bytes": s.swap_total_bytes, "compressed_bytes": s.compressed_bytes},
        "binaries": bins, "services": svc,
        "services_unparseable": [r["label"] for r in (svc or []) if r.get("parse_ok") is False],
        "cruise": cruise, "tailnet": tailnet(sensor.run),
    }


def write(hb, home=None):
    d = os.path.join(home or os.path.expanduser("~"), ".ashlr-fleet", "nodes"); os.makedirs(d, exist_ok=True)
    host = "".join(c if c.isalnum() or c in "._-" else "_" for c in hb["host"])[:64]
    p = os.path.join(d, host + ".json"); t = p + ".tmp"
    with open(t, "w") as f: json.dump(hb, f, indent=1, default=str)
    os.replace(t, p)
    return p
