"""Standalone metadata emitter for resource-pool-bridge.v1 (no dispatch)."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from urllib.parse import urlsplit


MAX_AGE = 300_000
MONTH = 30 * 86_400_000
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# Checkout-known launchers with the same fd-3 key boundary.
ZAI_BOUNDARIES = frozenset({
    "4167335dac896d6de7f8d04d960dc658978c3d37e604fea54109461c996d9919",
    "f863cb1c9b3938ad4e9ddf242fbf90142fb7e1dbab5b49d81addcb2186b73126",
})


class Held(ValueError):
    pass


def clock():
    return time.time_ns() // 1_000_000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def epoch(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def private(path, mode):
    info = path.lstat()
    return (path.is_absolute() and path.resolve(strict=True) == path
            and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == mode)


def snapshot(path, limit, mode=None):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or not 0 < info.st_size <= limit or info.st_nlink != 1
                or path.resolve(strict=True) != path
                or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
                or info.st_mode & 0o022):
            raise Held("input-unverified")
        data = source.read(limit + 1)
        if len(data) != info.st_size or epoch(path.lstat()) != epoch(info):
            raise Held("input-unverified")
        return data, info.st_mtime_ns // 1_000_000


def executable(path):
    if not path.is_absolute():
        raise Held("executable-unverified")
    resolved = path.resolve(strict=True)
    info = resolved.stat()
    if not stat.S_ISREG(info.st_mode) or not os.access(resolved, os.X_OK):
        raise Held("executable-unverified")
    with resolved.open("rb") as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
        if epoch(os.fstat(source.fileno())) != epoch(info) or epoch(resolved.stat()) != epoch(info):
            raise Held("executable-unverified")
    return resolved, epoch(info), digest.hexdigest()


def native_metadata(binary, args, env):
    result = subprocess.run([binary, *args], env=env, cwd=env["HOME"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=30, check=True)
    return result.stdout.decode("utf-8")


def devin_principal(output):
    output = ANSI.sub("", output)
    if not re.search(r"logged\s+in", output, re.I) or re.search(r"not\s+logged\s+in|logged\s+out", output, re.I):
        raise Held("devin-free-unverified")
    fields = {}
    for line in output.split("\n"):
        match = re.fullmatch(r"\s*(User ID|Team ID|Email|API server|Devin API):\s*(.*?)\s*", line)
        if match:
            name, value = match.groups()
            if name in fields or len(value.encode()) > 4096 or re.search(r"[\x00-\x1f\x7f]", value):
                raise Held("devin-free-unverified")
            if value.lower() in ("", "none", "null", "n/a", "-", "(none)"):
                value = None
            fields[name] = value
    basis = "user-id"
    principal = fields.get("User ID")
    if not principal:
        basis, principal = "email", (fields.get("Email") or "").lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+", principal):
            raise Held("devin-free-unverified")
    origins = []
    for name in ("API server", "Devin API"):
        raw = fields.get(name) or ""
        url = urlsplit(raw)
        host = url.hostname
        if (url.scheme != "https" or not host or url.username is not None or "?" in raw or "#" in raw
                or not re.fullmatch(r"(?:[a-z0-9-]+\.)*(?:devin\.ai|codeium\.com)", host)):
            raise Held("devin-free-unverified")
        origins.append("https://" + host + (f":{url.port}" if url.port not in (None, 443) else ""))
    identity = json.dumps(["devin-native-principal-v1", origins, basis, principal], ensure_ascii=False, separators=(",", ":"))
    return sha(identity.encode()), fields.get("Team ID")


def devin_free(output, model):
    if len(output.encode()) > 4 * 1024 * 1024:
        return False
    lines = ANSI.sub("", output).splitlines()
    count = [re.match(r"^Available models \((\d+) famil(?:y|ies)\)", line, re.I) for line in lines]
    declared = [int(match[1]) for match in count if match]
    families = []
    rows = []
    current = None
    for line in lines:
        if not line.strip():
            continue
        if not line[0].isspace():
            current = [] if re.fullmatch(r"\S[^()]*? \([a-z0-9][a-z0-9._-]{0,80}\)\s*", line, re.I) else None
            if current is not None:
                families.append(current)
            continue
        row = re.fullmatch(r"\s+(\S+)\s+(.+?)\s+\[([^\]]*)\]\s*", line)
        if row and current is not None:
            current.append(row[1])
            if row[1] == model:
                rows.append(row[3])
        elif re.match(r"\s+" + re.escape(model) + r"(?:\s|$)", line):
            return False
    if declared != [len(families)] or not all(families) or sum(map(len, families)) > 4000 or len(rows) != 1:
        return False
    tags = [tag.strip().lower() for tag in rows[0].split(",")]
    context = [tag for tag in tags if re.fullmatch(r"[1-9]\d*(?:\.\d+)?[km]? context", tag)]
    return len(context) == 1 and tags.count("free") == 1 and all(tag in (*context, "free", "new", "beta") for tag in tags)


def devin_evidence(binary, home, data_home, model, cap, *, run=native_metadata, now=clock):
    if not re.fullmatch(r"swe-2-flash-max|swe-2[.-]1(?:-[a-z0-9]+)*", model):
        raise Held("devin-free-unverified")
    if not (type(cap[0]) is int and 1 <= cap[0] <= 16 and type(cap[1]) is int and 1 <= cap[1] <= 10_000):
        raise Held("devin-reservation-cap-invalid")
    selected = executable(binary)
    credentials = data_home / "devin" / "credentials.toml"
    if not private(credentials, 0o600) or not credentials.is_file():
        raise Held("devin-free-unverified")
    creds = epoch(credentials.lstat())
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
    env.update(HOME=str(home), XDG_DATA_HOME=str(data_home), NO_COLOR="1")
    started = now()
    principal = devin_principal(run(selected[0], ("auth", "status"), env))
    check = lambda: epoch(credentials.lstat()) == creds and binary.resolve(strict=True) == selected[0] and epoch(selected[0].stat()) == selected[1]
    if not check() or not devin_free(run(selected[0], ("models", "list"), env), model) or not check():
        raise Held("devin-free-unverified")
    after = devin_principal(run(selected[0], ("auth", "status"), env))
    observed = now()
    if principal != after or not check() or not started <= observed <= started + MAX_AGE:
        raise Held("devin-free-unverified")
    return dict(schema="resource-pool-bridge.v1", lane="devin-flash", model=model, accountDigest=principal[0],
                executableSha256=selected[2], observedAt=observed, expiresAt=observed + MAX_AGE,
                billing=dict(kind="verified", plan="devin-cli-free"), quota=dict(kind="unknown"),
                reservationCap=dict(maxConcurrent=cap[0], maxPerHour=cap[1]))


def read_attestation(path, lane, now):
    raw = json.loads(snapshot(path, 4096, 0o600)[0])
    control = "autoRecharge" if lane == "zai" else "useG1Credits"
    plan = "zai-glm-coding-lite" if lane == "zai" else "google-ai-ultra-personal"
    if (not isinstance(raw, dict) or set(raw) != {"accountDigest", "plan", "attestedAt", "attestationExpiresAt", control}
            or raw["plan"] != plan or raw[control] is not False
            or not isinstance(raw["accountDigest"], str)
            or not re.fullmatch(r"[0-9a-f]{32}" if lane == "zai" else r"[0-9a-f]{64}", raw["accountDigest"])
            or type(raw["attestedAt"]) is not int or type(raw["attestationExpiresAt"]) is not int
            or not 0 <= raw["attestedAt"] <= now < raw["attestationExpiresAt"] <= raw["attestedAt"] + MONTH):
        raise Held("owner-attestation-unverified")
    return raw


def read_quota(path, lane, now):
    data, observed = snapshot(path, 1024 * 1024)
    doc = json.loads(data)
    rows = doc.get("lanes", doc) if isinstance(doc, dict) else {}
    row = rows.get(lane) if isinstance(rows, dict) else None
    if not isinstance(row, dict) or not now - MAX_AGE <= observed <= now:
        raise Held("quota-unverified")
    frac, reset = row.get("used_frac"), row.get("reset_at")
    if type(frac) not in (int, float) or not math.isfinite(frac) or frac < 0:
        raise Held("quota-unverified")
    if isinstance(reset, str):
        dt = datetime.fromisoformat(reset.replace("Z", "+00:00"))
        reset = dt.timestamp() if dt.tzinfo else None
    if type(reset) not in (int, float) or not math.isfinite(reset) or not now < reset * 1000 <= 8.64e15:
        raise Held("quota-unverified")
    return dict(kind="measured", usedPercent=math.floor(min(frac, 1) * 10_000 + 0.5) / 100,
                observedAt=observed, resetsAt=int(reset * 1000))


def zai_fingerprint(home, launcher):
    if sha(snapshot(launcher, 1024 * 1024)[0]) not in ZAI_BOUNDARIES:
        raise Held("zai-key-boundary-unverified")
    directory = home / ".zai-lane"
    if not directory.is_dir() or not private(directory, 0o700):
        raise Held("zai-key-boundary-unverified")
    data, modified = snapshot(directory / "api_key", 4096, 0o600)
    key, separator, trailing = data.partition(b"\n")
    if not key or not separator or trailing or any(byte < 33 or byte > 126 for byte in key):
        raise Held("zai-key-boundary-unverified")
    return sha(key)[:32], modified


def parse_pinned_agy_help():
    # Security must supply the real pinned sandbox/isolated-HOME /help capture before parsing.
    raise Held("agy-identity-unverified")


def plan_evidence(lane, model, home, binary, launcher, attestation, usage, *, now=clock):
    observed = now()
    raw = read_attestation(attestation, lane, observed)
    before = zai_fingerprint(home, launcher) if lane == "zai" else None
    quota = read_quota(usage, lane, observed)
    pin = raw.pop("accountDigest")
    if lane == "agy":
        parse_pinned_agy_help()
        raise Held("agy-identity-unverified")
    if (model not in ("glm-5.3", "glm-5.3-flash") or before is None or before[0] != pin
            or quota["observedAt"] < before[1] or zai_fingerprint(home, launcher) != before):
        raise Held("zai-key-boundary-unverified")
    digest = executable(binary)[2]
    expires = min(observed + MAX_AGE, quota["observedAt"] + MAX_AGE,
                  quota["resetsAt"], raw["attestationExpiresAt"])
    if now() >= expires:
        raise Held("quota-unverified")
    return dict(schema="resource-pool-bridge.v1", lane=lane, model=model, accountDigest=pin,
                executableSha256=digest, observedAt=observed, expiresAt=expires,
                billing=dict(kind="owner-attested-plan", **raw), quota=quota)


def publish(path, record):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        staging = Path(out.name)
        try:
            json.dump(record, out, separators=(",", ":"), allow_nan=False)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
            os.replace(staging, path)
        finally:
            staging.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lane", choices=("agy", "devin-flash", "zai"))
    parser.add_argument("--model", required=True)
    for name in ("output", "home", "executable", "data-home", "launcher", "attestation", "resources"):
        parser.add_argument("--" + name, type=Path, required=name in ("output", "home"))
    parser.add_argument("--max-concurrent", type=int)
    parser.add_argument("--max-per-hour", type=int)
    args = parser.parse_args(argv)
    try:
        if (args.output.parent.name != "bridge-evidence" or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}\.json", args.output.name)
                or not args.output.parent.is_dir() or not private(args.output.parent, 0o700)):
            raise Held("output-unverified")
        args.output.unlink(missing_ok=True)
        if not args.home.is_absolute() or args.home.resolve(strict=True) != args.home or not args.home.is_dir():
            raise Held("input-unverified")
        if args.lane == "devin-flash":
            if args.executable is None:
                raise Held("executable-unverified")
            record = devin_evidence(args.executable, args.home, args.data_home or args.home / ".local/share",
                                    args.model, (args.max_concurrent, args.max_per_hour))
        else:
            if args.attestation is None:
                raise Held("owner-attestation-unverified")
            if args.resources is None:
                raise Held("quota-unverified")
            if args.lane == "zai" and (args.launcher is None or args.executable is None):
                raise Held("zai-key-boundary-unverified")
            record = plan_evidence(args.lane, args.model, args.home, args.executable, args.launcher,
                                   args.attestation, args.resources)
        publish(args.output, record)
        return 0
    except Held as error:
        print(str(error), file=sys.stderr)
    except (AttributeError, OSError, OverflowError, ValueError, subprocess.SubprocessError):
        print("bridge-evidence-unverified", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
