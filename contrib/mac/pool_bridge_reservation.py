#!/usr/bin/env python3
"""Review-only Mac reservation supervisor. Invoke with Python -I."""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pool_bridge_evidence import (Held, MAX_AGE, clock, devin_evidence, executable, plan_evidence, private,
                                  parse_pinned_agy_help, publish, read_attestation, read_quota,
                                  sha, snapshot)


REVIEW = Path(__file__).resolve().parent / "host-integration"
PROJECTS = Path("/Users/masonwyatt/Projects/ashlrai")
SAFE_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DEVIN = Path("/opt/homebrew/bin/devin")
FLASH_PRESSURE = {
    "host_pressure_admission.py": "6b2e87df1253fbf501a31553562293e26862871b30d9823a5c87a4fe3ed15e80",
    "host_session_observation.py": "dfee0279acfa7f20bc93ce743c4afcc6581fb3f42f0cf62675c41a9513ef40de",
}
LIMITS = {"fast": (2, 80), "mid": (8, 120), "work": (15, 200), "frontier": (40, 600)}
ZAI_MODELS = {"fast": ("glm-5.3-flash", "40"), "work": ("glm-5.3", "60")}
ZAI_SETTINGS = "3a85cc369f6cd3b30a20b7ec596117c92866d6782233369d5fe7a66bf8554bfb"
ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}")
HEX = re.compile(r"[0-9a-f]{64}")


def check_request(r):
    keys = {"id", "pool", "worker", "lane", "model", "workspace", "paths", "mode", "tier",
            "maxFiles", "maxLines", "timeoutSeconds", "evidenceSha256", "accountDigest", "prompt"}
    if not isinstance(r, dict) or r.keys() != keys or any(
            not isinstance(r[k], str) or not ID.fullmatch(r[k]) for k in ("id", "pool", "worker")):
        raise Held("reservation-invalid")
    lane, tier = r["lane"], r["tier"]
    if (not isinstance(lane, str) or lane not in ("agy", "zai", "devin-flash")
            or not isinstance(tier, str) or tier not in LIMITS
            or r["mode"] not in ("read", "write")
            or not isinstance(r["model"], str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", r["model"])
            or not isinstance(r["evidenceSha256"], str) or not HEX.fullmatch(r["evidenceSha256"])
            or not isinstance(r["accountDigest"], str)
            or not re.fullmatch(r"[0-9a-f]{32}|[0-9a-f]{64}", r["accountDigest"])
            or not isinstance(r["prompt"], str) or not 0 < len(r["prompt"]) <= 65536
            or not isinstance(r["workspace"], str)):
        raise Held("reservation-invalid")
    files, lines = LIMITS[tier]
    for key, cap in (("maxFiles", files), ("maxLines", lines), ("timeoutSeconds", 2400)):
        if type(r[key]) is not int or not 1 <= r[key] <= cap:
            raise Held("scope-invalid")
    if (not isinstance(r["paths"], list) or len(r["paths"]) > r["maxFiles"]
            or any(not isinstance(p, str) or not re.fullmatch(r"[A-Za-z0-9._/-]{1,512}", p)
                   or any(part in ("", ".", "..", ".git") for part in p.split("/")) for p in r["paths"])
            or len(set(r["paths"])) != len(r["paths"])):
        raise Held("scope-invalid")
    if lane == "zai" and (tier not in ZAI_MODELS or r["model"] != ZAI_MODELS[tier][0]):
        raise Held("model-mismatch")


def workspace_for(r, projects=PROJECTS):
    ws = Path(r["workspace"])
    if (not ws.is_absolute() or ws.resolve(strict=True) != ws or not ws.is_dir()
            or ws.stat().st_uid != os.getuid() or not ws.is_relative_to(projects) or ws == projects):
        raise Held("workspace-unverified")
    for name in r["paths"]:
        path = ws / name
        if path.resolve() != path or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1)):
            raise Held("scope-invalid")
    return ws


def git(ws, *args):
    result = subprocess.run(["/usr/bin/git", "--no-optional-locks", "-C", str(ws), *args],
                            env={"PATH": SAFE_PATH, "GIT_CONFIG_NOSYSTEM": "1",
                                 "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"},
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=True)
    return result.stdout


def clean_baseline(ws):
    if (os.fsdecode(git(ws, "rev-parse", "--show-toplevel").rstrip(b"\n")) != str(ws)
            or git(ws, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching")):
        raise Held("workspace-not-clean")
    return git(ws, "rev-parse", "HEAD").strip()


def check_scope(ws, base, r):
    if git(ws, "rev-parse", "HEAD").strip() != base:
        raise Held("scope-violation")
    allowed = {os.fsencode(name) for name in r["paths"]} if r["mode"] == "write" else set()
    entries = git(ws, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none",
                  "--numstat", "-z", base, "--")
    changed, lines = set(), 0
    for entry in filter(None, entries.split(b"\0")):
        added, removed, path = entry.split(b"\t", 2)
        if path not in allowed or not (added.isdigit() and removed.isdigit()):
            raise Held("scope-violation")
        changed.add(path)
        lines += int(added) + int(removed)
    for path in filter(None, git(ws, "ls-files", "--others", "-z").split(b"\0")):
        if path not in allowed:
            raise Held("scope-violation")
        added = ws / os.fsdecode(path)
        data, _ = snapshot(added, 1024 * 1024)
        if b"\0" in data:
            raise Held("scope-violation")
        changed.add(path)
        lines += len(data.splitlines())
    for name in changed:
        path = ws / os.fsdecode(name)
        if path.resolve() != path or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1)):
            raise Held("scope-violation")
    if len(changed) > r["maxFiles"] or lines > r["maxLines"]:
        raise Held("scope-violation")


def derive_profile(original, writable):
    broad = f'(subpath "{PROJECTS}")'
    default = "(allow default)"
    if original.count(broad) != 1 or original.count(default) != 1:
        raise Held("sandbox-profile-unverified")
    replacement = '(subpath (param "POOL_WORKSPACE"))' if writable else ""
    return original.replace(default, default + "\n(deny file-write*)\n(allow file-write* (literal \"/dev/null\"))").replace(
        broad, replacement) + """
(deny file-read* file-write* (subpath (param "POOL_CLAIM")))
(allow file-read* file-write* (subpath (param "POOL_TEMP")))
(deny file-write* (subpath (string-append (param "POOL_WORKSPACE") "/.git")))
"""


def sandbox_command(sandbox, ws, claim, temp, profile_path):
    return [str(sandbox), "-D", f"POOL_WORKSPACE={ws}", "-D", f"POOL_CLAIM={claim}",
            "-D", f"POOL_TEMP={temp}", "-f", str(profile_path)]


def exists_group(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_group(child, grace=2):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            child.poll()
            return True
        except PermissionError:
            return False
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            child.poll()
            if not exists_group(child.pid):
                return True
            time.sleep(0.025)
    return not exists_group(child.pid)


def supervise(command, ws, env, prompt, output, deadline, cancelled, *, stderr=subprocess.DEVNULL, **kwargs):
    with tempfile.TemporaryFile() as stdin:
        stdin.write(prompt.encode())
        stdin.seek(0)
        child = subprocess.Popen(command, cwd=ws, env=env, stdin=stdin, stdout=output,
                                 stderr=stderr, start_new_session=True, **kwargs)
        while True:
            rc = child.poll()
            if rc is not None and not exists_group(child.pid):
                return rc, "completed" if rc == 0 else "provider-exit", True
            if cancelled() or time.monotonic() >= deadline or rc is not None:
                reason = "cancelled" if cancelled() else "timed-out" if rc is None else "provider-descendants"
                confirmed = stop_group(child)
                return child.poll(), reason if confirmed else "cancel-unconfirmed", confirmed
            time.sleep(0.025)


def pinned(path, ref):
    data, _ = snapshot(path, 1024 * 1024)
    if sha(data) != ref:
        raise Held("guard-source-drift")
    return data


def snapshot_refs():
    manifest = json.loads((REVIEW / "launcher-snapshot.json").read_text())
    return {row["name"]: row["sha256"] for row in manifest["files"]}


def flash_guard(r, home, runs, refs):
    guards = runs / "bin"
    names = ("devin_flash_lane.py", "devin-overage-stop.py", "agent.sb")
    if any(not (guards / name).is_file() or (guards / name).is_symlink()
           for name in (*names, *FLASH_PRESSURE, "launch.sh")):
        raise Held("guard-source-missing")
    verified = {name: pinned(guards / name, refs[name]) for name in (*names, "launch.sh")}
    for name, digest in FLASH_PRESSURE.items():
        pinned(guards / name, digest)
    env = {"HOME": str(home), "PATH": SAFE_PATH, "ASHLR_RUNS": str(runs)}
    stop = ["/usr/bin/python3", "-I", str(guards / "devin-overage-stop.py")]
    if (helper([*stop, "check"], env)
            or helper(["/usr/bin/python3", "-I", str(guards / "host_pressure_admission.py")], env)
            or helper(["/usr/bin/python3", "-I", str(guards / "devin_flash_lane.py"), "check-launch", r["model"]], env)):
        raise Held("devin-flash-refused")
    return verified["agent.sb"], stop, env


def replay_guard(state, r):
    claim = state / r["id"]
    try:
        claim.mkdir(mode=0o700)
    except FileExistsError:
        raise Held("reservation-replayed") from None
    return claim


def helper(args, env):
    return subprocess.run(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=20).returncode


def evidence_check(r, evidence_path, fresh):
    data, _ = snapshot(evidence_path, 4096, 0o600)
    evidence = json.loads(data)
    now = clock()
    if (sha(data) != r["evidenceSha256"] or not isinstance(evidence, dict)
            or any(evidence.get(k) != fresh.get(k) for k in
                   ("schema", "lane", "model", "accountDigest", "executableSha256", "billing", "reservationCap"))
            or r["accountDigest"] != fresh["accountDigest"]
            or type(evidence.get("observedAt")) is not int or type(evidence.get("expiresAt")) is not int
            or not now - MAX_AGE <= evidence["observedAt"] <= now < evidence["expiresAt"]
            <= evidence["observedAt"] + MAX_AGE):
        raise Held("bridge-evidence-unverified")
    return evidence["expiresAt"]


def update_flash_cap(state, r, cap, *, release=False):
    account = state / (".flash-" + r["accountDigest"])
    account.mkdir(mode=0o700, exist_ok=True)
    if not private(account, 0o700):
        raise Held("devin-reservation-cap-unverified")
    lock = account / "lock"
    ledger = account / "cap.json"
    with os.fdopen(os.open(lock, os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600), "rb+") as fd:
        fcntl.flock(fd, fcntl.LOCK_EX)
        now = clock()
        rows = json.loads(snapshot(ledger, 2 << 20, 0o600)[0]) if ledger.exists() else {}
        if not isinstance(rows, dict) or any(
                not ID.fullmatch(key) or not isinstance(row, list) or len(row) != 2
                or type(row[0]) is not int or not 0 <= row[0] <= now or type(row[1]) is not bool
                for key, row in rows.items()):
            raise Held("devin-reservation-cap-unverified")
        rows = {key: row for key, row in rows.items() if row[1] or row[0] > now - 3_600_000}
        if release and r["id"] not in rows:
            raise Held("devin-reservation-cap-unverified")
        if release:
            rows[r["id"]][1] = False
        else:
            if (r["id"] in rows or sum(row[1] for row in rows.values()) >= cap[0]
                    or sum(row[0] > now - 3_600_000 for row in rows.values()) >= cap[1]):
                raise Held("devin-reservation-cap-held")
            rows[r["id"]] = [now, True]
        publish(ledger, rows)


@contextmanager
def prepare_flash(r, home, ws, claim, evidence_path, sandbox, runs):
    refs = snapshot_refs()
    profile, stop, guard_env = flash_guard(r, home, runs, refs)
    data, _ = snapshot(evidence_path, 4096, 0o600)
    proof = json.loads(data)
    cap = proof.get("reservationCap") if isinstance(proof, dict) else None
    if sha(data) != r["evidenceSha256"] or not isinstance(cap, dict):
        raise Held("bridge-evidence-unverified")
    cap = cap.get("maxConcurrent"), cap.get("maxPerHour")
    data_home = home / ".local" / "share"
    native, identity, digest = executable(DEVIN)
    fresh = devin_evidence(DEVIN, home, data_home, r["model"], cap)
    expires = min(fresh["expiresAt"], evidence_check(r, evidence_path, fresh))
    if executable(DEVIN) != (native, identity, digest) or digest != fresh["executableSha256"]:
        raise Held("executable-unverified")
    temp = claim / "tmp"
    temp.mkdir(mode=0o700)
    prompt = temp / "prompt"
    profile = derive_profile(profile.decode(), r["mode"] == "write").encode()
    profile_path = claim / "profile.sb"
    profile_path.write_bytes(profile)
    publish(claim / "evidence.json", fresh)
    env = {"HOME": str(home), "PATH": SAFE_PATH, "TMPDIR": str(temp), "XDG_DATA_HOME": str(data_home),
           "LANG": "en_US.UTF-8"}
    command = [*sandbox_command(sandbox, ws, claim, temp, profile_path), str(native),
               "--permission-mode", "dangerous", "--respect-workspace-trust", "false",
               "--model", r["model"], "-p", "--prompt-file", str(prompt)]
    update_flash_cap(claim.parent, r, cap)
    finished = {"confirmed": False}
    try:
        if helper([*stop, "check"], guard_env):
            update_flash_cap(claim.parent, r, cap, release=True)
            raise Held("devin-flash-refused")
        if clock() >= expires:
            update_flash_cap(claim.parent, r, cap, release=True)
            raise Held("bridge-evidence-unverified")
        with prompt.open("x", encoding="utf-8") as out:
            out.write(r["prompt"])
        with tempfile.TemporaryFile(dir=claim) as log:
            yield command, env, digest, sha(profile), finished, (), log, subprocess.STDOUT
            if not finished["confirmed"]:
                return
            if finished.get("contacted"):
                with tempfile.NamedTemporaryFile(dir=claim) as scan_log:
                    end = log.seek(0, os.SEEK_END)
                    log.seek(max(0, end - 65536))
                    scan_log.write(log.read(65536))
                    scan_log.flush()
                    try:
                        status = helper([*stop, "scan", r["id"], str(finished["rc"]), scan_log.name], guard_env)
                    except (OSError, subprocess.SubprocessError):
                        return
                if status not in (0, 4):
                    return
                if status == 4:
                    finished["refusal"] = "devin-overage-held"
            update_flash_cap(claim.parent, r, cap, release=True)
            finished["recorded"] = True
    finally:
        prompt.unlink(missing_ok=True)


@contextmanager
def prepare_zai(r, home, ws, claim, evidence_path, attestation, sandbox, binary, runs):
    bin_dir = runs / "bin"
    refs = snapshot_refs()
    launcher = bin_dir / "launch.sh"
    pinned(launcher, refs["launch.sh"])
    base_profile = pinned(bin_dir / "zai.sb", refs["zai.sb"])
    pacer = bin_dir / "zai-pace.py"
    pinned(pacer, refs["zai-pace.py"])
    config = home / ".zai-lane" / "claude"
    pinned(config / "settings.json", ZAI_SETTINGS)
    native, _, digest = executable(binary)
    usage = runs / "queue" / "resources.json"
    key, _ = snapshot(home / ".zai-lane" / "api_key", 4096, 0o600)
    fresh = plan_evidence("zai", r["model"], home, native, launcher, attestation, usage)
    evidence_check(r, evidence_path, fresh)
    rules = pinned(bin_dir / "lane_rules.py", refs["lane_rules.py"])
    lane_rules = {"__name__": "lane_rules"}
    exec(compile(rules, str(bin_dir / "lane_rules.py"), "exec"), lane_rules)
    if lane_rules["lane_over_window"]("zai", res_lane={"used_frac": fresh["quota"]["usedPercent"] / 100}):
        raise Held("zai-pacing-held")
    if sha(key[:-1])[:32] != fresh["accountDigest"]:
        raise Held("zai-key-boundary-unverified")
    temp = claim / "tmp"
    temp.mkdir(mode=0o700)
    profile = derive_profile(base_profile.decode(), r["mode"] == "write").encode()
    profile_path = claim / "profile.sb"
    profile_path.write_bytes(profile)
    publish(claim / "evidence.json", fresh)
    env = {"HOME": str(home), "PATH": SAFE_PATH, "TMPDIR": str(temp), "LANG": "en_US.UTF-8",
           "CLAUDE_CONFIG_DIR": str(config), "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
           "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3", "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3",
           "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1"}
    command = [*sandbox_command(sandbox, ws, claim, temp, profile_path), str(native),
               "-p", "--dangerously-skip-permissions", "--setting-sources", "user",
               "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
               "--max-turns", ZAI_MODELS[r["tier"]][1], "--model", r["model"], "--output-format", "json"]
    pace_env = {"HOME": str(home), "PATH": SAFE_PATH}
    pace_cmd = ["/usr/bin/python3", "-I", str(pacer)]
    # The pacer uses the same quota ledger as the live launcher.
    job = "pool-" + r["id"]
    if helper([*pace_cmd, "gate", job, r["tier"]], pace_env):
        raise Held("zai-pacing-held")
    finished = {"confirmed": False}
    try:
        if clock() >= fresh["expiresAt"]:
            finished["confirmed"] = True
            raise Held("bridge-evidence-unverified")
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, "rb") as credential, os.fdopen(write_fd, "wb") as feed:
            feed.write(key)
            feed.close()
            launch = ["/bin/bash", "-c", 'IFS= read -r ANTHROPIC_AUTH_TOKEN <&"$1" || exit 5; '
                      '[[ "$1" =~ ^[0-9]+$ ]] || exit 5; eval "exec $1<&-"; '
                      'export ANTHROPIC_AUTH_TOKEN; shift; exec "$@"',
                      "zai", str(credential.fileno()), *command]
            yield launch, env, digest, sha(profile), finished, (credential.fileno(),), subprocess.DEVNULL, subprocess.DEVNULL
    finally:
        if finished["confirmed"]:
            # If no trusted usage is available, the existing pacer charges the full reservation.
            try:
                finished["recorded"] = helper([*pace_cmd, "record", job, "1", "", ""], pace_env) == 0
            except (OSError, subprocess.SubprocessError):
                finished["recorded"] = False


def run(r, state, home, evidence_path, attestation, cancelled, *, projects=PROJECTS,
        sandbox=Path("/usr/bin/sandbox-exec"), runs=None):
    check_request(r)
    if not private(state, 0o700) or not state.is_dir():
        raise Held("state-unverified")
    claim = replay_guard(state, r)
    settlement = claim / "settlement.json"
    row = dict(schema="resource-pool-bridge-settlement.v1", reservationId=r["id"], lane=r["lane"],
               model=r["model"], evidenceSha256=r["evidenceSha256"], executableSha256=None,
               profileSha256=None, startedAt=None, endedAt=None, exitStatus=None, usage=None,
               contacted=False, groupState="not-started", reason="reservation-pending")
    publish(settlement, row)
    try:
        if cancelled():
            raise Held("cancelled")
        runs = runs or (home / ".ashlr-runs")
        hold = runs / "HOLD"
        if (runs / "PAUSE").exists() or (hold.exists() and
                r["lane"].encode() in snapshot(hold, 8192)[0].splitlines()):
            raise Held("launcher-held")
        if r["lane"] == "agy":
            read_attestation(attestation, "agy", clock())
            read_quota(runs / "queue" / "resources.json", "agy", clock())
            parse_pinned_agy_help()
            raise Held("agy-identity-unverified")
        ws = workspace_for(r, projects)
        if state.is_relative_to(ws):
            raise Held("state-unverified")
        base = clean_baseline(ws)
        flash = r["lane"] == "devin-flash"
        if flash:
            preparation = prepare_flash(r, home, ws, claim, evidence_path, sandbox, runs)
        else:
            binary = shutil.which("claude", path=SAFE_PATH)
            if not binary:
                raise Held("executable-unverified")
            preparation = prepare_zai(r, home, ws, claim, evidence_path, attestation, sandbox, Path(binary), runs)
        with preparation as prepared:
            command, env, digest, profile, finished, pass_fds, output, stderr = prepared
            if cancelled():
                finished["confirmed"] = True
                row["reason"] = "cancelled"
            else:
                row.update(startedAt=clock(), executableSha256=digest, profileSha256=profile,
                           groupState="unconfirmed", reason="cancel-unconfirmed", contacted=True)
                publish(settlement, row)
                rc, reason, confirmed = supervise(command, ws, env, "" if flash else r["prompt"], output,
                                                   time.monotonic() + r["timeoutSeconds"], cancelled,
                                                   pass_fds=pass_fds, stderr=stderr)
                finished.update(confirmed=confirmed, contacted=True, rc=rc if rc is not None else 1)
                row.update(exitStatus=rc, reason=reason, groupState="exited" if confirmed else "unconfirmed")
                if confirmed:
                    try:
                        check_scope(ws, base, r)
                    except (Held, OSError, subprocess.SubprocessError):
                        if reason == "completed":
                            row["reason"] = "scope-violation"
                        row["scopeRejected"] = True
        if finished["confirmed"] and not finished.get("recorded"):
            row["reason"] = "flash-settlement-unconfirmed" if flash else "pacing-settlement-unconfirmed"
        if "refusal" in finished:
            row["reason"] = finished["refusal"]
    except Held as exc:
        row["reason"] = str(exc)
    except (OSError, ValueError, subprocess.SubprocessError):
        if row["groupState"] != "unconfirmed":
            row["reason"] = "bridge-unverified"
    finally:
        row["endedAt"] = clock()
        publish(settlement, row)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("request", "state", "evidence", "attestation"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("mac-bridge-requires-darwin", file=sys.stderr)
        return 5
    stopped = False

    def cancel(_signal, _frame):
        nonlocal stopped
        stopped = True

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, cancel)
    try:
        data, _ = snapshot(args.request, 512 * 1024, 0o600)
        row = run(json.loads(data), args.state, Path(pwd.getpwuid(os.getuid()).pw_dir),
                  args.evidence, args.attestation, lambda: stopped)
    except (Held, OSError, ValueError):
        print("reservation-unverified", file=sys.stderr)
        return 5
    print(json.dumps(row, separators=(",", ":")))
    return 0 if row["reason"] == "completed" else 5


if __name__ == "__main__":
    sys.exit(main())
