import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pool_bridge_evidence as evidence
import pool_bridge_reservation as bridge


class ReservationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        self.runs = self.home / ".ashlr-runs"
        self.projects = self.home / "projects"
        self.ws = self.projects / "repo"
        self.ws.mkdir(parents=True)
        self.state = self.home / "settlements"
        self.state.mkdir(mode=0o700)
        for args in (("init", "-q"), ("config", "user.name", "Fixture"),
                     ("config", "user.email", "fixture@example.invalid")):
            bridge.git(self.ws, *args)
        (self.ws / "a.txt").write_text("old\n")
        (self.ws / "b.txt").write_text("other\n")
        bridge.git(self.ws, "add", ".")
        bridge.git(self.ws, "commit", "-qm", "fixture")
        self.r = dict(id="test-1", pool="pool", worker="worker", lane="zai", model="glm-5.3-flash",
                      workspace=str(self.ws), paths=["a.txt"], mode="write", tier="fast",
                      maxFiles=1, maxLines=4, timeoutSeconds=5, evidenceSha256="b" * 64,
                      accountDigest="c" * 32, prompt="fixture prompt")

    def put(self, rel, data, mode=0o600):
        path = self.home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def setup_zai(self, changed="a.txt", text="new"):
        live_bin = self.runs / "bin"
        live_bin.mkdir(parents=True)
        for name in ("launch.sh", "zai.sb", "zai-pace.py", "lane_rules.py"):
            shutil.copyfile(bridge.REVIEW / name, live_bin / name)
        key = self.put(".zai-lane/api_key", b"fixture-credential\n")
        key.parent.chmod(0o700)
        config = self.put(".zai-lane/claude/settings.json", b"{}")
        binary = self.put("fake-claude", b"#!/bin/sh\nexit 99\n", 0o700)
        now = evidence.clock()
        pin = evidence.sha(b"fixture-credential")[:32]
        att = self.put("attestation", json.dumps(dict(accountDigest=pin, plan="zai-glm-coding-lite",
                       autoRecharge=False, attestedAt=now - 100, attestationExpiresAt=now + 120_000)).encode())
        quota = self.put(".ashlr-runs/queue/resources.json",
                         json.dumps({"lanes": {"zai": {"used_frac": 0.05, "reset_at": (now + 150_000) / 1000}}}).encode())
        proof = evidence.plan_evidence("zai", self.r["model"], self.home, binary, live_bin / "launch.sh", att, quota)
        proof_path = self.home / "evidence"
        evidence.publish(proof_path, proof)
        self.r.update(accountDigest=pin, evidenceSha256=evidence.sha(proof_path.read_bytes()))
        sandbox = self.put("sandbox-exec", f"""#!/usr/bin/env python3
import os, pathlib, sys
assert os.environ.get("ANTHROPIC_AUTH_TOKEN") == "fixture-credential"
args = sys.argv[1:]
assert f"POOL_WORKSPACE={{os.getcwd()}}" in args
assert sys.stdin.read() == "fixture prompt"
profile = pathlib.Path(args[args.index("-f") + 1]).read_bytes()
pathlib.Path({str(self.home / "captured.sb")!r}).write_bytes(profile)
pathlib.Path({changed!r}).write_text({text!r} + "\\n")
""".encode(), 0o700)
        self.addCleanup(patch.stopall)
        patch.object(bridge.shutil, "which", return_value=str(binary)).start()
        patch.object(bridge, "ZAI_SETTINGS", evidence.sha(config.read_bytes())).start()
        return proof_path, att, sandbox

    def invoke(self, proof=None, attestation=None, sandbox=None):
        return bridge.run(self.r, self.state, self.home, proof, attestation, lambda: False,
                          projects=self.projects, sandbox=sandbox)

    def test_fake_sandbox_captures_narrowed_profile_and_settles(self):
        row = self.invoke(*self.setup_zai())
        self.assertEqual(row["reason"], "completed", row)
        profile = (self.home / "captured.sb").read_text()
        self.assertNotIn(f'(subpath "{bridge.PROJECTS}")', profile)
        self.assertIn('(subpath (param "POOL_WORKSPACE"))', profile)
        self.assertIn('(deny file-read* file-write* (subpath (param "POOL_CLAIM")))', profile)
        self.assertEqual(row["groupState"], "exited")
        record = self.state / self.r["id"] / "settlement.json"
        self.assertEqual(json.loads(record.read_bytes()), row)
        self.assertNotIn("fixture-credential", record.read_text())
        self.assertIsNone(row["usage"])
        pacing = json.loads((self.runs / "queue/zai.usage.json").read_text())
        self.assertEqual(pacing["reserved"], {})
        self.assertEqual(pacing["events"][0][1], 250)
        with self.assertRaisesRegex(evidence.Held, "reservation-replayed"):
            self.invoke()

    def test_read_only_profile_has_no_workspace_write_allowance(self):
        profile = bridge.derive_profile((bridge.REVIEW / "agy.sb").read_text(), False)
        self.assertNotIn('(subpath (param "POOL_WORKSPACE"))', profile)
        self.assertNotIn(f'(subpath "{bridge.PROJECTS}")', profile)

    def test_out_of_scope_result_is_rejected_and_settled(self):
        row = self.invoke(*self.setup_zai(changed="b.txt"))
        self.assertEqual(row["reason"], "scope-violation", row)
        self.assertTrue(row["scopeRejected"])
        self.assertEqual(row["groupState"], "exited")

    def test_line_limit_and_path_escape(self):
        row = self.invoke(*self.setup_zai(text="a\nb\nc\nd"))
        self.assertEqual(row["reason"], "scope-violation", row)
        with self.assertRaisesRegex(evidence.Held, "scope-invalid"):
            bridge.check_request({**self.r, "paths": ["../escape"]})

    def test_flash_missing_guard_refuses_before_contact(self):
        self.r.update(lane="devin-flash", model="swe-2-flash-max")
        row = self.invoke()
        self.assertEqual(row["reason"], "guard-source-missing")
        self.assertFalse(row["contacted"])

    def setup_flash(self, output="fixture output"):
        self.r.update(lane="devin-flash", model="swe-2-flash-max")
        root = self.runs / "bin"
        root.mkdir(parents=True)
        for name in ("launch.sh", "agent.sb", "devin_flash_lane.py", "devin-overage-stop.py"):
            shutil.copyfile(bridge.REVIEW / name, root / name)
        for name in bridge.FLASH_PRESSURE:
            shutil.copyfile(bridge.REVIEW.parent / name, root / name)
        binary = self.put("fake-devin", f"""#!/usr/bin/python3
import sys
from pathlib import Path
args = sys.argv[1:]
if args == ["auth", "status"]:
    print("Logged in\\nUser ID: flash-fixture\\nAPI server: https://api.devin.ai\\nDevin API: https://devin.ai")
elif args == ["models", "list"]:
    print("Available models (1 family)\\nSWE (swe)\\n  swe-2-flash-max  Flash [262K context, Free]")
else:
    assert args[args.index("--model") + 1] == "swe-2-flash-max"
    assert Path(args[args.index("--prompt-file") + 1]).read_text() == "fixture prompt"
    Path("a.txt").write_text("Flash edit\\n")
    print({output!r}, file=sys.stderr)
""".encode(), 0o700)
        data_home = self.home / ".local" / "share"
        self.put(".local/share/devin/credentials.toml", b"fixture")
        proof = evidence.devin_evidence(binary, self.home, data_home, self.r["model"], (1, 2))
        path = self.home / "evidence"
        evidence.publish(path, proof)
        self.r.update(accountDigest=proof["accountDigest"], evidenceSha256=evidence.sha(path.read_bytes()))
        sandbox = self.put("sandbox-exec", b"""#!/usr/bin/python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
at = args.index("-f")
profile = Path(args[at + 1]).read_text()
assert '(deny file-write*)' in profile
assert '(subpath (param "POOL_WORKSPACE"))' in profile
assert 'Projects/ashlrai")' not in profile
os.execv(args[at + 2], args[at + 2:])
""", 0o700)
        self.addCleanup(patch.stopall)
        patch.object(bridge, "DEVIN", binary).start()
        helper = bridge.helper
        self.guard_calls = []

        def guarded(args, env):
            self.guard_calls.append((Path(args[2]).name, args[3:]))
            self.assertEqual(env["ASHLR_RUNS"], str(self.runs))
            if Path(args[2]).name in ("devin_flash_lane.py", "host_pressure_admission.py"):
                return 0
            return helper(args, env)

        patch.object(bridge, "helper", side_effect=guarded).start()
        return path, None, sandbox

    def test_flash_scans_stderr_and_sets_live_style_hold_in_fixture(self):
        row = self.invoke(*self.setup_flash("ERROR: billing required"))
        self.assertEqual(row["reason"], "devin-overage-held", row)
        self.assertEqual(row["groupState"], "exited")
        self.assertEqual(row["exitStatus"], 0)
        self.assertTrue((self.runs / "queue" / "DEVIN_STOP").is_file())
        self.assertNotIn("billing required", json.dumps(row))
        self.assertIn(("devin_flash_lane.py", ["check-launch", self.r["model"]]), self.guard_calls)
        (self.ws / "a.txt").write_text("old\n")
        self.r["id"] = "test-2"
        row = self.invoke(self.home / "evidence")
        self.assertEqual(row["reason"], "devin-flash-refused")
        self.assertFalse(row["contacted"])

    def test_flash_unconfirmed_exit_does_not_scan_or_release_cap(self):
        args = self.setup_flash()
        with patch.object(bridge, "supervise", return_value=(None, "cancel-unconfirmed", False)):
            row = self.invoke(*args)
        self.assertEqual(row["reason"], "cancel-unconfirmed", row)
        self.assertFalse(any(args and args[0] == "scan" for _, args in self.guard_calls))
        self.r["id"] = "test-2"
        row = self.invoke(*args)
        self.assertEqual(row["reason"], "devin-reservation-cap-held")

    def test_flash_guard_digest_drift_does_not_launch(self):
        args = self.setup_flash()
        (self.runs / "bin" / "agent.sb").write_text("unreviewed")
        row = self.invoke(*args)
        self.assertEqual(row["reason"], "guard-source-drift")
        self.assertFalse(row["contacted"])
        self.assertEqual(self.guard_calls, [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "synthetic sandbox only")
    def test_offline_verifier_passes_and_rejects_unconfined_dummy(self):
        sandbox = self.put("offline-sandbox", b"""#!/usr/bin/python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
at = args.index("-f")
profile = Path(args[at + 1]).read_text()
assert '(deny file-write*)' in profile
assert '(subpath (param "POOL_WORKSPACE"))' in profile
command = args[at + 2:]
if not Path(os.environ["TMPDIR"]).parent.joinpath("allow-outside").exists():
    Path(os.environ["TMPDIR"], "outside").mkdir()
    command[2] += '; /bin/rmdir "$TMPDIR/outside"'
os.execv(command[0], command)
""", 0o700)
        command = ["/bin/bash", str(bridge.REVIEW / "verify-pool-bridge.sh")]
        env = {"TMPDIR": str(self.home), "POOL_BRIDGE_FIXTURE_SANDBOX": str(sandbox)}
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
        verdict = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, verdict)
        self.assertEqual(verdict["mode"], "synthetic")
        self.assertTrue(all(verdict["checks"].values()))
        self.assertEqual(set(verdict["profileSha256s"]), {"agent", "zai"})
        self.put("allow-outside", b"")
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=30)
        verdict = json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(verdict["checks"]["agentOutsideBlocked"])
        self.assertFalse(verdict["checks"]["zaiOutsideBlocked"])
        self.assertTrue(verdict["checks"]["groupCancelled"])

    def test_agy_attestation_and_quota_do_not_substitute_for_identity(self):
        self.r.update(lane="agy", model="gemini-3.8-flash-medium")
        now = evidence.clock()
        att = self.put("attestation", json.dumps(dict(accountDigest="b" * 64,
                       plan="google-ai-ultra-personal", useG1Credits=False, attestedAt=now - 100,
                       attestationExpiresAt=now + 120_000)).encode())
        self.put(".ashlr-runs/queue/resources.json",
                 json.dumps({"lanes": {"agy": {"used_frac": 0.05, "reset_at": (now + 150_000) / 1000}}}).encode())
        row = self.invoke(attestation=att)
        self.assertEqual(row["reason"], "agy-identity-unverified")
        self.assertFalse(row["contacted"])

    def test_zai_paid_overage_attestation_refuses_before_contact(self):
        proof, att, sandbox = self.setup_zai()
        att.write_text(json.dumps(json.loads(att.read_text()) | {"autoRecharge": True}))
        row = self.invoke(proof, att, sandbox)
        self.assertEqual(row["reason"], "owner-attestation-unverified")
        self.assertFalse(row["contacted"])
        self.assertFalse((self.home / "captured.sb").exists())

    def test_group_cancel_terminates_foreground_and_descendant(self):
        ready = self.home / "ready"
        code = """
import pathlib, signal, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
def stop(*args):
    child.wait(timeout=2)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
child.wait()
"""
        _, reason, confirmed = bridge.supervise([sys.executable, "-c", code, str(ready)], self.ws,
                                               {}, "prompt", subprocess.DEVNULL,
                                               time.monotonic() + 5, ready.exists)
        self.assertTrue(confirmed)
        self.assertEqual(reason, "cancelled")
        with self.assertRaises(ProcessLookupError):
            os.kill(int(ready.read_text()), 0)

    def test_uncertain_exit_is_held(self):
        with patch.object(bridge, "exists_group", return_value=True), patch.object(bridge, "stop_group", return_value=False):
            _, reason, confirmed = bridge.supervise(["/bin/true"], self.ws, {}, "prompt",
                                                   subprocess.DEVNULL, time.monotonic() + 5, lambda: False)
        self.assertFalse(confirmed)
        self.assertEqual(reason, "cancel-unconfirmed")

    def test_review_manifest_matches_all_nine_sources(self):
        files = json.loads((bridge.REVIEW / "launcher-snapshot.json").read_text())["files"]
        self.assertEqual(len(files), 9)
        for entry in files:
            self.assertEqual(evidence.sha((bridge.REVIEW / entry["name"]).read_bytes()), entry["sha256"])
            self.assertEqual(entry["livePath"], "~/.ashlr-runs/bin/" + entry["name"])
            self.assertEqual(entry["class"], "pinned")


if __name__ == "__main__":
    unittest.main()
