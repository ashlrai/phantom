#!/usr/bin/env python3
"""Report or apply the declared Mac fleet profile (Python 3.11+)."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import tomllib


ROOT = Path(__file__).parent
FILES = ("Brewfile", "npm-globals.txt", "agent-defaults.json")
CONFIGS = {
    "devin": (".config/devin/config.json", {"local_tools_approval_mode": str}),
    "claude": (".claude/settings.json", {"permissions.defaultMode": str, "skipDangerousModePermissionPrompt": bool}),
    "codex": (".codex/config.toml", {"approval_policy": str, "sandbox_mode": str}),
}
LOGINS = {
    "devin": (["auth", "status"], "devin auth login"),
    "gh": (["auth", "status", "--hostname", "github.com"], "gh auth login"),
    "claude": (["auth", "status"], "claude auth login"),
    "codex": (["login", "status"], "codex login"),
    "agy": (["models"], "agy"),
}
GH_VERIFY = "https://github.com/login/device"
BREW_ITEM = re.compile(r'(brew|cask) "([a-z0-9][a-z0-9._+-]*)"')
NPM_ITEM = re.compile(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*')
CREDENTIAL_KEY = re.compile(r'(?:^|[_-])(?:api[_-]?key|token|password|secret|authorization|credentials?)$', re.I)
REMOTE = (
    "import json,sys; "
    "source,profile,args=json.load(sys.stdin); "
    "scope={'__file__':'apply.py','__name__':'fleet_profile'}; "
    "exec(compile(source,'apply.py','exec'),scope); "
    "sys.exit(scope['main'](args,profile))"
)


def entries(raw):
    return [line.strip() for line in raw.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def parse_profile(profile):
    brew = [BREW_ITEM.fullmatch(line) for line in entries(profile["Brewfile"])]
    npm = entries(profile["npm-globals.txt"])
    defaults = json.loads(profile["agent-defaults.json"])
    if not all(brew) or not all(NPM_ITEM.fullmatch(name) for name in npm) or not isinstance(defaults, dict):
        raise ValueError
    logins = defaults.pop("logins", [])
    if not isinstance(logins, list) or any(type(tool) is not str or tool not in LOGINS for tool in logins):
        raise ValueError
    for agent, values in defaults.items():
        if agent not in CONFIGS or not isinstance(values, dict) or any(
            type(value) is not CONFIGS[agent][1].get(key) for key, value in values.items()
        ):
            raise ValueError
    return [match.groups() for match in brew], npm, defaults, list(dict.fromkeys(logins))


def run(args, data=None, timeout=60, env=None, stderr=subprocess.DEVNULL):
    return subprocess.run(
        args, input=data, stdin=subprocess.DEVNULL if data is None else None,
        stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
        cwd="/" if args[0] != "ssh" else None, timeout=timeout,
        env={**(os.environ if env is None else env), "HOMEBREW_NO_ANALYTICS": "1", "HOMEBREW_NO_AUTO_UPDATE": "1"},
    )


NPM = ["npm", "--logs-max=0", "--no-update-notifier", "--userconfig=/dev/null", "--globalconfig=/dev/fd/0"]


def inventory(args, decode):
    try:
        proc = run(args)
        return set(decode(proc.stdout)) if proc.returncode == 0 else None
    except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return None


def npm_inventory():
    return inventory([*NPM, "list", "-g", "--depth=0", "--json"],
                     lambda out: json.loads(out).get("dependencies", {}).keys())


def config_source(path):
    # Do not follow aliases to credential files, including linked parent directories.
    current = Path.home()
    for part in path.relative_to(current).parts:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError
    return path.read_bytes().decode("utf-8")


def contains_credential(value):
    if isinstance(value, dict):
        return any(CREDENTIAL_KEY.search(key) or contains_credential(child) for key, child in value.items())
    return isinstance(value, list) and any(map(contains_credential, value))


def patch_toml(text, original, changes):
    for key, value in changes.items():
        replacement = f"{key} = {json.dumps(value, ensure_ascii=False)}"
        expected = {**original, key: value}
        if key not in original:
            text = replacement + "\n" + text
        else:
            line_pattern = re.compile(
                rf"""(?m)^([ \t]*)(?:{key}|"{key}"|'{key}')[ \t]*=[ \t]*(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')([ \t]*(?:\#[^\r\n]*)?)(?=\r?$)"""
            )
            for match in line_pattern.finditer(text):
                candidate = text[:match.start()] + match[1] + replacement + match[2] + text[match.end():]
                try:
                    if tomllib.loads(candidate) != expected:
                        continue
                except tomllib.TOMLDecodeError:
                    continue
                text = candidate
                break
            else:
                raise ValueError
        if tomllib.loads(text) != expected:
            raise ValueError
        original = expected
    return text


def plan_config(path, wanted):
    source = config_source(path)
    is_toml = path.suffix == ".toml"
    original = (tomllib.loads(source) if is_toml else json.loads(source)) if source is not None else {}
    if not isinstance(original, dict) or contains_credential(original):
        raise ValueError
    changes, statuses = {}, {}
    for key, value in wanted.items():
        parent, dot, leaf = key.partition(".")
        group = original.get(parent, {}) if dot else original
        if not isinstance(group, dict):
            raise ValueError
        name = leaf if dot else key
        statuses[key] = ("missing" if name not in group else
                         "in-sync" if type(group[name]) is type(value) and group[name] == value else "drift")
        if statuses[key] != "in-sync":
            changes[key] = value
            if not is_toml:
                group[name] = value
                if dot:
                    original[parent] = group
    updated = (patch_toml(source or "", original, changes) if is_toml else
               json.dumps(original, indent=2, ensure_ascii=False) + "\n") if changes else None
    return statuses, source, updated


def write_config(path, source, updated):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    if source is not None:
        fd = os.open(f"{path}.bak-fleet-{stamp}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as backup:
            backup.write(source.encode("utf-8"))
    fd, tmp = tempfile.mkstemp(prefix=".fleet-profile-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as update:
            update.write(updated.encode("utf-8"))
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def local_report(profile, apply):
    brew, npm, defaults, logins = parse_profile(profile)
    items, errors, updates = {}, [], []
    for agent, wanted in defaults.items():
        if not wanted:
            continue
        path = Path.home() / CONFIGS[agent][0]
        try:
            statuses, source, updated = plan_config(path, wanted)
            items.update({f"config:{agent}.{key}": state for key, state in statuses.items()})
            if updated is not None:
                updates.append((agent, path, source, updated))
        except (OSError, ValueError):
            items.update({f"config:{agent}.{key}": "unknown" for key in wanted})
            errors.append(f"cannot safely merge {agent} config")
    if apply and not errors:
        installs = [
            ("brew bundle", lambda: not brew or run(
                ["brew", "bundle", "--no-upgrade", "--file=-"], profile["Brewfile"], timeout=3600).returncode == 0),
            ("npm install", lambda: install_npm(npm)),
        ]
        for name, install in installs:
            try:
                if install():
                    continue
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
            errors.append(f"{name} failed")
            break
        if not errors:
            for agent, path, source, updated in updates:
                try:
                    if config_source(path) != source:
                        raise ValueError
                    write_config(path, source, updated)
                    items.update({f"config:{agent}.{key}": "in-sync" for key in defaults[agent]})
                except (OSError, ValueError):
                    errors.append(f"cannot update {agent} config")
    for kind, flag in (("brew", "--formula"), ("cask", "--cask")):
        names = [name for item_kind, name in brew if item_kind == kind]
        if names:
            package_rows(items, errors, "formula" if kind == "brew" else kind, names,
                         inventory(["brew", "list", flag], str.split))
    if npm:
        package_rows(items, errors, "npm", npm, npm_inventory())
    for tool in logins:
        items[f"login:{tool}"] = login_status(tool)
    return {"schema": "fleet.profile.v1", "dry_run": not apply, "items": items, "errors": errors}


def install_npm(names):
    if not names:
        return True
    installed = npm_inventory()
    missing = [name for name in names if installed is None or name not in installed]
    return not missing or run([*NPM, "i", "-g", *missing], timeout=3600).returncode == 0


def package_rows(items, errors, kind, names, installed):
    if installed is None:
        errors.append(f"{kind} inventory unavailable")
    for name in names:
        items[f"{kind}:{name}"] = "unknown" if installed is None else "in-sync" if name in installed else "missing"


def login_env():
    return {**{key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")},
            "NO_COLOR": "1", "GH_PROMPT_DISABLED": "1"}


def login_status(tool):
    try:
        proc = run([tool, *LOGINS[tool][0]], timeout=8, env=login_env(), stderr=subprocess.PIPE)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return "unknown"
    answer = proc.stdout + "\n" + proc.stderr
    if re.search(r"\b(?:not (?:logged|signed) in|login required|unauthenticated)\b", answer, re.I):
        return "login-needed"
    if proc.returncode == 0:
        return "logged-in"
    return "login-needed" if proc.returncode == 1 and tool in ("claude", "codex") else "unknown"


def github_approval():
    command = ["gh", "auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"]
    try:
        worker = subprocess.Popen([sys.executable, "-I", "-c",
                                   "import subprocess,sys; subprocess.run(sys.argv[1:],timeout=900)", *command],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  cwd="/", env=login_env(), start_new_session=True)
        deadline, log = time.monotonic() + 15, b""
        with worker.stdout, selectors.DefaultSelector() as ready:
            ready.register(worker.stdout, selectors.EVENT_READ)
            while len(log) < 8192 and ready.select(max(0, deadline - time.monotonic())):
                chunk = os.read(worker.stdout.fileno(), 1024)
                if not chunk:
                    break
                log += chunk
                code = re.search(rb"(?m)^! First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})\r?$", log)
                if code and f"Open this URL to continue in your web browser: {GH_VERIFY}\n".encode() in log:
                    return code[1].decode("ascii")
        os.killpg(worker.pid, signal.SIGTERM)
        worker.wait()
    except (OSError, ValueError):
        pass
    return None


def login_plan(profile, host):
    plan = []
    for tool in parse_profile(profile)[3]:
        status = login_status(tool)
        if status == "logged-in":
            continue
        row = {"tool": tool, "host": host}
        code = github_approval() if tool == "gh" and status == "login-needed" else None
        plan.append({**row, "action": "approve", "url": GH_VERIFY, "code": code} if code else
                    {**row, "action": "manual", "command": LOGINS[tool][1]})
    return plan


def remote_report(host, source, profile, args):
    command = 'PATH=/opt/homebrew/bin:/usr/local/bin:"$PATH" python3 -I -c ' + shlex.quote(REMOTE)
    try:
        proc = run(["ssh", "-a", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                    "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=10", host, command],
                   json.dumps([source, profile, args]), timeout=7500 if "--apply" in args else 210)
        if proc.returncode in (0, 1):
            report = json.loads(proc.stdout)
            if "--login" in args and proc.returncode == 0 and isinstance(report, list):
                return [login_row(row, host) for row in report], []
            if report.get("schema") == "fleet.profile.v1":
                return report["items"], report["errors"]
    except (OSError, ValueError, TypeError, AttributeError, KeyError, subprocess.TimeoutExpired):
        pass
    return {}, ["SSH/profile check failed"]


def login_row(row, host):
    tool, action = row["tool"], row["action"]
    if tool == "gh" and action == "approve" and re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}", row["code"]):
        return {"tool": tool, "host": host, "action": action, "url": GH_VERIFY, "code": row["code"]}
    if tool not in LOGINS or action != "manual":
        raise ValueError
    return {"tool": tool, "host": host, "action": action, "command": LOGINS[tool][1]}


def main(argv=None, profile=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true", help="install packages and update only managed defaults")
    modes.add_argument("--login", action="store_true", help="start supported device flows and report owner actions")
    parser.add_argument("--json", action="store_true", help="emit JSON (the default)")
    parser.add_argument("--host", action="append", default=[], help="explicit SSH config alias; repeat for a matrix")
    args = parser.parse_args(argv)
    if any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", host) for host in args.host):
        parser.error("--host requires an SSH config alias")
    try:
        if profile is None:
            profile = {name: (ROOT / name).read_text(encoding="utf-8") for name in FILES}
        if args.host:
            parse_profile(profile)
            source = Path(__file__).read_text(encoding="utf-8")
            hosts = list(dict.fromkeys(args.host))
            mode = ["--apply"] if args.apply else ["--login"] if args.login else []
            results = {host: remote_report(host, source, profile, mode) for host in hosts}
            if args.login:
                print(json.dumps([row for rows, _ in results.values() if rows for row in rows], indent=2))
                for host, (_, errors) in results.items():
                    if errors:
                        print(f"{host}: SSH/profile login check failed", file=sys.stderr)
                return int(any(errors for _, errors in results.values()))
            matrix = {item: {host: results[host][0].get(item, "unknown") for host in hosts}
                      for item in sorted({item for rows, _ in results.values() for item in rows})}
            report = {"schema": "fleet.profile.matrix.v1", "dry_run": not args.apply, "hosts": hosts,
                      "items": matrix, "errors": {host: errors for host, (_, errors) in results.items() if errors}}
        elif args.login:
            print(json.dumps(login_plan(profile, "local"), indent=2))
            return 0
        else:
            report = local_report(profile, args.apply)
    except (OSError, ValueError, KeyError):
        parser.exit(2, "fleet profile: cannot read or validate profile declarations\n")
    print(json.dumps(report, indent=2))
    return int(bool(report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
