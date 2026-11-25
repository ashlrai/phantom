import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock


SCRIPT = Path(__file__).resolve().parents[1] / "profile/apply.py"
FAKE = """import json, os, sys
from pathlib import Path
tool, *args = sys.argv
tool = Path(tool).name
if tool == 'ssh':
    os.execv('/bin/sh', ['sh', '-c', args[-1]])
if 'bundle' in args or 'i' in args or tool in ('winget', 'apt-get', 'pipx', 'ollama'):
    if tool in ('winget', 'apt-get', 'pipx', 'ollama'):
        with (Path.home() / (tool + '-commands')).open('a') as log:
            log.write(' '.join(args) + '\\n')
        sys.exit(0)
    Path.home().joinpath(tool + '-installed').write_text(sys.stdin.read() if tool == 'brew' else ' '.join(args))
elif tool == 'brew':
    print('gh' if '--formula' in args else '')
elif tool == 'npm':
    print(json.dumps({'dependencies': {'ccusage': {}}}))
elif tool == 'gh' and 'login' in args:
    print('! First copy your one-time code: ABCD-EFGH', flush=True)
    print('Open this URL to continue in your web browser: https://github.com/login/device', flush=True)
else:
    print('logged in' if tool == 'claude' else 'not logged in', 'fixture-private-data', file=sys.stderr)
    sys.exit(0 if tool == 'claude' else 1)
"""
AUDIT = """
import os, platform, runpy, sys
platform.system = lambda: os.environ['TEST_SYSTEM']
platform.machine = lambda: 'x86_64'
def protect(event, args):
    if event == 'open' and isinstance(args[0], str) and os.path.basename(args[0]) in ('auth.json', 'credentials.toml'):
        raise AssertionError('credential file opened')
sys.addaudithook(protect)
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        bindir = self.home / "bin"
        bindir.mkdir()
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(bindir), "TEST_SYSTEM": "Darwin"}
        (bindir / "python3").symlink_to(sys.executable)
        for tool in ("brew", "npm", "ssh", "devin", "gh", "claude", "codex", "agy", "cursor-agent",
                     "winget", "apt-get", "pipx", "ollama"):
            fake = bindir / tool
            fake.write_text(f"#!{sys.executable}\n{FAKE}")
            fake.chmod(0o700)
        self.claude = self.fixture(".claude/settings.json", '{"permissions":{"allow":["Read"]},"theme":"dark"}')
        self.codex = self.fixture(".codex/config.toml", 'approval_policy = "on-request" # keep\n[profiles.local]\nsandbox_mode = "read-only"\n')
        self.fixture(".codex/auth.json", "fixture-private-data")
        self.fixture(".config/devin/credentials.toml", "fixture-private-data")

    def fixture(self, name, contents):
        path = self.home / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        return path

    def profile(self, *args):
        proc = subprocess.run([sys.executable, "-B", "-c", AUDIT, str(SCRIPT), *args],
                              env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("fixture-private-data", proc.stdout + proc.stderr)
        return json.loads(proc.stdout)

    def test_drift_is_read_only_and_reports_per_host(self):
        before = set(self.home.rglob("*"))
        items = self.profile()["items"]
        for key, state in {"entry:gh": "in-sync", "entry:node": "missing", "entry:docker-desktop": "missing",
                           "entry:ccusage": "in-sync", "config:codex.approval_policy": "drift",
                           "config:claude.permissions.defaultMode": "missing", "login:claude": "logged-in"}.items():
            self.assertEqual(items[key], state)
        self.assertEqual(set(self.home.rglob("*")), before)
        row = self.profile("--host", "one", "--host", "two")["items"]["login:codex"]
        self.assertEqual(row, {"one": "login-needed", "two": "login-needed"})

    def test_apply_merges_and_backs_up_only_settings(self):
        before = {path: path.read_bytes() for path in (self.claude, self.codex)}
        self.profile("--apply")
        self.assertEqual(json.loads(self.claude.read_text())["permissions"], {"allow": ["Read"], "defaultMode": "bypassPermissions"})
        self.assertIn('approval_policy = "never" # keep\n[profiles.local]\nsandbox_mode = "read-only"', self.codex.read_text())
        for path, original in before.items():
            backup, = path.parent.glob(path.name + ".bak-fleet-*")
            self.assertEqual(backup.read_bytes(), original)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertIn('cask "docker-desktop"', (self.home / "brew-installed").read_text())
        self.assertIn("@openai/codex", (self.home / "npm-installed").read_text())

    def test_login_prints_only_safe_actions(self):
        rows = {row["tool"]: row for row in self.profile("--login", "--host", "one")}
        self.assertNotIn("claude", rows)
        self.assertEqual(rows["codex"], {"tool": "codex", "host": "one", "action": "manual", "command": "codex login"})
        self.assertEqual(rows["gh"], {"tool": "gh", "host": "one", "action": "approve",
                                      "url": "https://github.com/login/device", "code": "ABCD-EFGH"})
        self.assertEqual(rows["cursor-agent"]["command"], "cursor-agent login")

    def test_windows_and_linux_installers_and_report_only_models(self):
        self.env["TEST_SYSTEM"] = "Windows"
        items = self.profile("--apply")["items"]
        self.assertEqual(items["entry:ghostty"], "unsupported-on-windows")
        self.assertEqual(items["entry:grok-bot"], "manual")
        self.assertIn("--id Anysphere.Cursor", (self.home / "winget-commands").read_text())
        self.assertFalse((self.home / "brew-installed").exists())
        self.assertFalse((self.home / "apt-get-commands").exists())
        self.env["TEST_SYSTEM"] = "Linux"
        items = self.profile("--apply")["items"]
        self.assertEqual(items["entry:ghostty"], "unsupported-on-linux")
        self.assertEqual(items["model:ollama:llama3.2"], "report-only")
        self.assertIn("install -y git nodejs", (self.home / "apt-get-commands").read_text())
        self.assertEqual((self.home / "pipx-commands").read_text().strip(), "install uv")
        self.assertIn("bun", (self.home / "npm-installed").read_text())
        self.assertFalse((self.home / "ollama-commands").exists())

    def test_copy_only_allows_application_paths_and_checks_signature_before_transfer(self):
        parse = runpy.run_path(str(SCRIPT))["parse_profile"]
        entry = {"id": "app", "kind": "desktop-app", "install": {"manual": "From peer"},
                 "detect": {"path": "/Applications/My App.app"}, "copyFromHost": {"host": "peer"}}
        for path in ("/Applications/My App", "/Applications/../Secrets.app",
                     "/Users/me/Library/Application Support/My App.app", "/Users/me/Library/Keychains/Test.app"):
            entry["copyFromHost"]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                parse({"schema": "fleet.profile.v1", "entries": [entry]})
        entry["copyFromHost"]["path"] = "/Applications/My App.app"
        parse({"schema": "fleet.profile.v1", "entries": [entry]})
        copy = parse.__globals__["copy_app"]
        remote = Mock(return_value=subprocess.CompletedProcess([], 1))
        copy.__globals__["run"] = remote
        self.assertFalse(copy(entry["copyFromHost"]))
        remote.assert_called_once()
        self.assertIn("codesign --verify --deep --strict", remote.call_args.args[0][-1])
