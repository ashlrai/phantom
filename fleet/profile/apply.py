#!/usr/bin/env python3
"""Report or apply the declared fleet profile (Python 3.11+)."""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
from urllib.parse import parse_qsl, urlsplit


ROOT = Path(__file__).parent
SCHEMA = "fleet.profile.v1"
CONFIGS = {
    "devin": (".config/devin/config.json", {"local_tools_approval_mode": str}),
    "claude": (".claude/settings.json", {"permissions.defaultMode": str, "skipDangerousModePermissionPrompt": bool}),
    "codex": (".codex/config.toml", {"approval_policy": str, "sandbox_mode": str}),
}
GH_VERIFY = "https://github.com/login/device"
GUI_LOGINS = {"agy", "devin", "cursor-agent"}
TERMINAL_START = {"agy": ["agy"], "devin": ["devin", "auth", "login"]}
CLAUDE_STATUS = ["claude", "auth", "status", "--json"]
CLAUDE_START = ["claude", "auth", "login"]
GUI_WAIT = 27
TERMINAL = 'on run argv\n tell application "Terminal" to do script (item 1 of argv)\nend run'
BROWSER_WORKER = """
import os, selectors, subprocess, sys, time
with subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
    with selectors.DefaultSelector() as ready:
        ready.register(child.stdout, selectors.EVENT_READ)
        deadline, forward = time.monotonic() + 900, True
        while ready.select(max(0, deadline - time.monotonic())) and time.monotonic() < deadline:
            chunk = os.read(child.stdout.fileno(), 1024)
            if not chunk:
                break
            if forward:
                try:
                    os.write(1, chunk)
                except BrokenPipeError:
                    forward = False
        try:
            child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            child.kill()
"""
OS_INSTALLERS = {"macos": ("brew", "brewCask", "npm"), "windows": ("winget",),
                 "linux": ("apt", "npm", "pipx")}
PACKAGE = re.compile(r"(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*/)?[a-zA-Z0-9][a-zA-Z0-9._+-]*")
HOST = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*")
APP = re.compile(r"/Applications/[a-zA-Z0-9][a-zA-Z0-9 ._-]*\.app")
SSH = ["ssh", "-a", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
       "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=10"]
CREDENTIAL_KEY = re.compile(r'(?:^|[_-])(?:api[_-]?key|token|password|secret|authorization|credentials?)$', re.I)
REMOTE = (
    "import json,os,sys; "
    "sys.platform == 'darwin' and os.environ.update(PATH='/opt/homebrew/bin:/usr/local/bin:'+os.environ['PATH']); "
    "source,profile,args=json.load(sys.stdin); "
    "scope={'__file__':'apply.py','__name__':'fleet_profile'}; "
    "exec(compile(source,'apply.py','exec'),scope); "
    "sys.exit(scope['main'](args,profile,remote_source=source))"
)


def argv_list(value):
    return isinstance(value, list) and bool(value) and all(isinstance(arg, str) and arg for arg in value)


def parse_profile(profile):
    entries, defaults = profile["entries"], profile.get("agentDefaults", {})
    if profile["schema"] != SCHEMA or not isinstance(entries, list) or not isinstance(defaults, dict):
        raise ValueError
    ids = set()
    for entry in entries:
        name, kind, install, detect = (entry[key] for key in ("id", "kind", "install", "detect"))
        if not HOST.fullmatch(name) or name in ids or kind not in ("cli", "desktop-app", "mcp", "sdk", "api", "local-model"):
            raise ValueError
        ids.add(name)
        if not isinstance(install, dict) or not isinstance(detect, dict) or set(detect) not in ({"path"}, {"command"}):
            raise ValueError
        for installer, value in install.items():
            if installer == "script":
                if not isinstance(value, dict) or not all(map(argv_list, value.values())):
                    raise ValueError
            elif installer == "manual":
                if not isinstance(value, str) or not value.strip():
                    raise ValueError
            elif installer not in {"brew", "brewCask", "winget", "apt", "npm", "pipx"} or not PACKAGE.fullmatch(value):
                raise ValueError
        for value in detect.values():
            if not (isinstance(value, str) and value or argv_list(value)):
                raise ValueError
        if "login" in entry:
            login = entry["login"]
            if kind == "desktop-app":
                if (set(login) != {"app"} or not isinstance(login["app"], str)
                        or not APP.fullmatch(f"/Applications/{login['app']}.app")):
                    raise ValueError
            elif not all(argv_list(login[key]) for key in ("status", "start")):
                raise ValueError
        if "models" in entry and (kind != "local-model" or not argv_list(entry["models"])):
            raise ValueError
        if "copyFromHost" in entry:
            peer = entry["copyFromHost"]
            if kind != "desktop-app" or set(install) != {"manual"} or not (
                HOST.fullmatch(peer["host"]) and APP.fullmatch(peer["path"])
            ):
                raise ValueError
    for agent, values in defaults.items():
        if agent not in CONFIGS or not isinstance(values, dict) or any(
            type(value) is not CONFIGS[agent][1].get(key) for key, value in values.items()
        ):
            raise ValueError
    return entries, defaults


def run(args, data=None, timeout=60, env=None, stderr=subprocess.DEVNULL):
    return subprocess.run(
        args, input=data, stdin=subprocess.DEVNULL if data is None else None,
        stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
        cwd=Path.home().anchor if args[0] != "ssh" else None, timeout=timeout,
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


def host_os():
    return {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}.get(platform.system(), sys.platform)


def installer_for(entry, os_name):
    available = entry["install"]
    for key in OS_INSTALLERS.get(os_name, ()):
        if key in available:
            return key, available[key]
    scripts = available.get("script", {})
    for target in (f"{os_name}-{platform.machine().lower()}", os_name):
        if target in scripts:
            return "script", scripts[target]
    if os_name == "macos" and "copyFromHost" in entry:
        return "copy", entry["copyFromHost"]
    return ("manual", available["manual"]) if "manual" in available else (None, None)


def detected(entry):
    key, values = next(iter(entry["detect"].items()))
    for value in [values] if isinstance(values, str) else values:
        if key == "command":
            if shutil.which(value, path=os.environ.get("PATH", os.defpath)):
                return True
        else:
            path = Path(os.path.expandvars(value)).expanduser()
            if path.is_absolute() and path.exists():
                return True
    return False


def package_state(entry, installer, value, inventories, os_name):
    if installer is None:
        return f"unsupported-on-{os_name}"
    if installer in inventories:
        packages = inventories[installer]
        if packages is not None and value in packages:
            return "in-sync"
        if installer == "npm":
            return "unknown" if packages is None else "missing"
    if detected(entry) or installer == "copy" and Path(value["path"]).exists():
        return "in-sync"
    if installer == "manual":
        return "manual"
    return "unknown" if installer in inventories and inventories[installer] is None else "missing"


def copy_app(peer):
    host, source = peer["host"], peer["path"]
    destination = Path(source)
    if destination.exists() or destination.is_symlink() or destination.parent.is_symlink():
        return False
    verify = ["codesign", "--verify", "--deep", "--strict", "-R", "anchor apple generic"]
    quoted = shlex.quote(source)
    check = f"test ! -L /Applications && test -d {quoted} && test ! -L {quoted} && {shlex.join([*verify, source])}"
    if run([*SSH, host, check]).returncode:
        return False
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".fleet-app-") as stage:
        if run(["rsync", "-a", "--safe-links", "--protect-args", "-e", shlex.join(SSH),
                f"{host}:{source}", stage], timeout=3600).returncode:
            return False
        bundle = Path(stage) / destination.name
        if bundle.is_symlink() or not bundle.is_dir() or run([*verify, str(bundle)]).returncode:
            return False
        if destination.exists() or destination.is_symlink():
            return False
        bundle.rename(destination)
    return True


def package_inventories(selections):
    commands = {"brew": "--formula", "brewCask": "--cask"}
    inventories = {kind: inventory(["brew", "list", flag], str.split)
                   for kind, flag in commands.items() if kind in selections}
    if "npm" in selections:
        inventories["npm"] = npm_inventory()
    return inventories


def install_packages(selections):
    brewfile = "".join(f'{label} "{name}"\n' for key, label in (("brew", "brew"), ("brewCask", "cask"))
                       for name in selections.get(key, []))
    apt, npm = selections.get("apt", []), selections.get("npm", [])
    commands = []
    if brewfile:
        commands.append((["brew", "bundle", "--no-upgrade", "--file=-"], brewfile))
    if apt:
        commands.append((["apt-get", "install", "-y", *apt], None))
    if npm:
        commands.append(([*NPM, "i", "-g", *npm], None))
    commands.extend((["pipx", "install", name], None) for name in selections.get("pipx", []))
    commands.extend((["winget", "install", "--exact", "--id", name, "--source", "winget",
                      "--disable-interactivity"], None) for name in selections.get("winget", []))
    commands.extend((argv, None) for argv in selections.get("script", []))
    try:
        for argv, data in commands:
            if run(argv, data, timeout=3600).returncode:
                return False
        return all(map(copy_app, selections.get("copy", [])))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def local_report(profile, apply, remote_source=None):
    entries, defaults = parse_profile(profile)
    os_name = host_os()
    choices = {entry["id"]: installer_for(entry, os_name) for entry in entries}
    inventories = package_inventories({installer for installer, _ in choices.values()})
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
        pending = {}
        for entry in entries:
            installer, value = choices[entry["id"]]
            if package_state(entry, installer, value, inventories, os_name) in ("missing", "unknown"):
                group = pending.setdefault(installer, [])
                if value not in group:
                    group.append(value)
        if not install_packages(pending):
            errors.append("package or app installation failed")
        inventories = package_inventories(inventories)
        if not errors:
            for agent, path, source, updated in updates:
                try:
                    if config_source(path) != source:
                        raise ValueError
                    write_config(path, source, updated)
                    items.update({f"config:{agent}.{key}": "in-sync" for key in defaults[agent]})
                except (OSError, ValueError):
                    errors.append(f"cannot update {agent} config")
    states = login_states(profile_logins(profile), remote_source)
    for entry in entries:
        name = entry["id"]
        items[f"entry:{name}"] = package_state(entry, *choices[name], inventories, os_name)
        for model in entry.get("models", []):
            items[f"model:{name}:{model}"] = "report-only"
        if name in states:
            items[f"login:{name}"] = states[name]
    return {"schema": SCHEMA, "dry_run": not apply, "items": items, "errors": errors}


def login_env():
    return {**{key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GITHUB_TOKEN")},
            "NO_COLOR": "1", "GH_PROMPT_DISABLED": "1"}


def login_status(tool, command):
    try:
        proc = run(command, timeout=8, env=login_env(), stderr=subprocess.PIPE)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return "unknown"
    if tool == "claude" and command == CLAUDE_STATUS:
        try:
            logged_in = json.loads(proc.stdout).get("loggedIn")
        except (ValueError, AttributeError):
            return "unknown"
        return {True: "logged-in", False: "login-needed"}[logged_in] if type(logged_in) is bool else "unknown"
    answer = proc.stdout + "\n" + proc.stderr
    if tool == "agy" and re.search(r"\bplease sign in\b", answer, re.I):
        return "login-needed"
    if re.search(r"\b(?:not (?:logged|signed) in|login required|unauthenticated)\b", answer, re.I):
        return "login-needed"
    if proc.returncode == 0:
        return "logged-in"
    return "login-needed" if proc.returncode == 1 and tool in ("claude", "codex") else "unknown"


def terminal_launch(command):
    try:
        shell = "cd / && " + shlex.join(command)
        return run(["osascript", "-e", TERMINAL, shell], timeout=5).returncode == 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def gui_checks(commands, source):
    if not commands:
        return {}
    with tempfile.TemporaryDirectory(prefix="fleet-gui-") as temp:
        script, result = Path(temp) / "probe.py", Path(temp) / "states.json"
        script.write_text(source + "\n" + """
def write_gui_states(commands, result):
    states = {tool: login_status(tool, command) for tool, command in commands.items()}
    booleans = {tool: state == "logged-in" for tool, state in states.items() if state != "unknown"}
    fd = os.open(result, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(booleans, output)

write_gui_states(json.loads(sys.argv[1]), sys.argv[2])
""", encoding="utf-8")
        script.chmod(0o600)
        launch = ["/usr/bin/env", f"PATH={os.environ.get('PATH', os.defpath)}", sys.executable,
                  "-I", "-c", "import runpy,sys; sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0])",
                  str(script), json.dumps(commands), str(result)]
        if terminal_launch(launch):
            deadline = time.monotonic() + GUI_WAIT
            while time.monotonic() < deadline:
                try:
                    states = json.loads(result.read_text(encoding="utf-8"))
                    return {tool: "logged-in" if states[tool] else "login-needed"
                            for tool in commands if type(states.get(tool)) is bool}
                except (OSError, ValueError, AttributeError):
                    time.sleep(0.1)
    return {}


def login_states(logins, remote_source):
    cli = {tool: login["status"] for tool, login in logins.items() if "status" in login}
    gui = {tool: cli.pop(tool) for tool in cli.keys() & GUI_LOGINS} if (
        remote_source is not None and host_os() == "macos") else {}
    states = {tool: login_status(tool, command) for tool, command in cli.items()}
    states.update(dict.fromkeys(gui, "unknown-over-ssh"))
    try:
        states.update(gui_checks(gui, remote_source))
    except OSError:
        pass
    return states


def github_code(log):
    code = re.search(rb"(?m)^! First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})\r?$", log)
    if code and f"Open this URL to continue in your web browser: {GH_VERIFY}\n".encode() in log:
        return code[1].decode("ascii")


def claude_url(url):
    if not re.fullmatch(r"https://[A-Za-z0-9./?&=%_~+:-]{1,4096}", url):
        return None
    target = urlsplit(url)
    if (target.netloc in {"claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"}
            and target.path in {"/oauth/authorize", "/oauth/authorize/"} and all(
                key in {"client_id", "redirect_uri", "response_type", "scope", "code_challenge",
                        "code_challenge_method", "state", "prompt", "audience"} or (key, value) == ("code", "true")
                for key, value in parse_qsl(target.query, keep_blank_values=True, strict_parsing=True))):
        return url


def claude_approval_url(log):
    for url in re.findall(rb"https://[^\s<>\x1b]+(?=\s|\x1b)", log):
        try:
            if approved := claude_url(url.decode("ascii")):
                return approved
        except (UnicodeError, ValueError):
            continue


def browser_approval(command, extract):
    try:
        worker = subprocess.Popen([sys.executable, "-I", "-c", BROWSER_WORKER, *command],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  cwd="/", env=login_env(), start_new_session=True)
        deadline, log = time.monotonic() + 15, b""
        with worker.stdout, selectors.DefaultSelector() as ready:
            ready.register(worker.stdout, selectors.EVENT_READ)
            while len(log) < 8192 and ready.select(max(0, deadline - time.monotonic())):
                chunk = os.read(worker.stdout.fileno(), min(1024, 8192 - len(log)))
                if not chunk:
                    break
                log += chunk
                if approval := extract(log):
                    return approval
        os.killpg(worker.pid, signal.SIGTERM)
        worker.wait()
    except (OSError, ValueError):
        pass
    return None


def login_action(tool, login, status):
    if "app" in login:
        command = ["open", "-a", login["app"]]
        try:
            if host_os() == "macos" and run(command, timeout=5).returncode == 0:
                return {"action": "approve-in-app"}
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        return {"action": "manual", "app": login["app"]}
    start = login["start"]
    if status == "login-needed" and os.name == "posix":
        if tool == "gh" and start == ["gh", "auth", "login"] and (
            login["status"] == ["gh", "auth", "status", "--hostname", "github.com"]
        ):
            command = [*start, "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"]
            if code := browser_approval(command, github_code):
                return {"action": "approve", "url": GH_VERIFY, "code": code}
        elif tool == "claude" and start == CLAUDE_START and login["status"] == CLAUDE_STATUS:
            if url := browser_approval(start, claude_approval_url):
                return {"action": "approve", "url": url}
        elif TERMINAL_START.get(tool) == start and host_os() == "macos":
            binary = shutil.which(start[0])
            if binary and terminal_launch([binary, *start[1:]]):
                return {"action": "approve-in-terminal"}
    row = {"action": "manual", "command": shlex.join(start)}
    if status == "unknown-over-ssh":
        row["status"] = status
    return row


def login_plan(profile, host, remote_source=None):
    logins = profile_logins(profile)
    states = login_states(logins, remote_source)
    plan = []
    for tool, login in logins.items():
        if states.get(tool) != "logged-in":
            plan.append({"tool": tool, "host": host, **login_action(tool, login, states.get(tool))})
    return plan


def profile_logins(profile):
    return {entry["id"]: entry["login"] for entry in parse_profile(profile)[0] if "login" in entry}


def remote_report(host, source, profile, args):
    encoded = base64.b64encode(REMOTE.encode()).decode()
    command = f"python3 -I -c \"exec(__import__('base64').b64decode('{encoded}'))\""
    try:
        data, timeout = json.dumps([source, profile, args]), 7500 if "--apply" in args else 210
        proc = run([*SSH, host, command], data, timeout=timeout)
        if proc.returncode in (127, 49, 9009):
            proc = run([*SSH, host, command.replace("python3 ", "python ", 1)], data, timeout=timeout)
        if proc.returncode in (0, 1):
            report = json.loads(proc.stdout)
            if "--login" in args and proc.returncode == 0 and isinstance(report, list):
                logins = profile_logins(profile)
                return [login_row(row, host, logins) for row in report], []
            if report.get("schema") == SCHEMA:
                return report["items"], report["errors"]
    except (OSError, ValueError, TypeError, AttributeError, KeyError, subprocess.TimeoutExpired):
        pass
    return {}, ["SSH/profile check failed"]


def login_row(row, host, logins):
    tool, action = row["tool"], row["action"]
    login, result = logins[tool], {"tool": tool, "host": host, "action": action}
    if action == "approve":
        if tool == "gh" and re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}", row["code"]):
            return {**result, "url": GH_VERIFY, "code": row["code"]}
        if tool == "claude" and (url := claude_url(row["url"])):
            return {**result, "url": url}
    if action == "approve-in-terminal" and tool in TERMINAL_START:
        return result
    if action == "approve-in-app" and "app" in login:
        return result
    if action == "manual":
        if "app" in login:
            return {**result, "app": login["app"]}
        if tool in GUI_LOGINS and row.get("status") == "unknown-over-ssh":
            result["status"] = "unknown-over-ssh"
        return {**result, "command": shlex.join(login["start"])}
    raise ValueError


def main(argv=None, profile=None, remote_source=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true", help="install packages and update only managed defaults")
    modes.add_argument("--login", action="store_true", help="start supported sign-in flows and report owner actions")
    parser.add_argument("--json", action="store_true", help="emit JSON (the default)")
    parser.add_argument("--host", action="append", default=[], help="explicit SSH config alias; repeat for a matrix")
    args = parser.parse_args(argv)
    if any(not HOST.fullmatch(host) for host in args.host):
        parser.error("--host requires an SSH config alias")
    try:
        if profile is None:
            profile = json.loads((ROOT / "profile.json").read_text(encoding="utf-8"))
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
            print(json.dumps(login_plan(profile, "local", remote_source), indent=2))
            return 0
        else:
            report = local_report(profile, args.apply, remote_source)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        parser.exit(2, "fleet profile: cannot read or validate profile declarations\n")
    print(json.dumps(report, indent=2))
    return int(bool(report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
