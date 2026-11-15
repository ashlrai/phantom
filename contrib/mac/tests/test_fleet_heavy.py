import ast
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "fleet-heavy"
loader = importlib.machinery.SourceFileLoader("heavy", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
heavy = importlib.util.module_from_spec(spec)
loader.exec_module(heavy)


class HeavyTests(unittest.TestCase):
    def test_acquire_release_and_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a, b = heavy.acquire(root, 2), heavy.acquire(root, 2)
            self.assertIsNone(heavy.acquire(root, 2))
            os.close(a)
            c = heavy.acquire(root, 2)
            self.assertIsNotNone(c)
            os.close(b)
            os.close(c)

    def test_competing_processes_obey_limit_and_log_wait(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = ("import os,time; p=" + repr(str(Path(tmp) / "active")) +
                      "; fd=os.open(p, os.O_CREAT|os.O_EXCL|os.O_WRONLY); time.sleep(.3); os.close(fd); os.unlink(p)")
            argv = [sys.executable, str(SCRIPT), "--slots", "1", "--",
                    sys.executable, "-c", script]
            children = [subprocess.Popen(argv, env=dict(os.environ, HOME=tmp),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(4)]
            for child in children:
                self.assertEqual(child.wait(timeout=10), 0)
            rows = [json.loads(line) for line in
                    (Path(tmp) / ".ashlr-runs/queue/heavy/events.jsonl").read_text().splitlines()]
            self.assertEqual(len(rows), 4)
            self.assertGreater(max(row["wait_s"] for row in rows), .6)

    def test_stale_pid_reclaimed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "slot-0").write_text("999999999")
            fd = heavy.acquire(root, 1)
            self.assertEqual((root / "slot-0").read_text(), str(os.getpid()))
            os.close(fd)

    def test_crash_holds_slot_until_child_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "started"
            env = dict(os.environ, HOME=tmp)
            proc = subprocess.Popen([sys.executable, str(SCRIPT), "--slots", "1", "--",
                sys.executable, "-c",
                "import os,pathlib,time; pathlib.Path(" + repr(str(marker)) +
                ").write_text(str(os.getpid())); time.sleep(30)"], env=env)
            pid = None
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(marker.exists())
                pid = int(marker.read_text())
                proc.kill()
                proc.wait(timeout=5)
                root = Path(tmp) / ".ashlr-runs/queue/heavy"
                self.assertIsNone(heavy.acquire(root, 1))
                os.kill(pid, signal.SIGKILL)
                fd = None
                deadline = time.monotonic() + 5
                while fd is None and time.monotonic() < deadline:
                    fd = heavy.acquire(root, 1)
                    if fd is None: time.sleep(.02)
                self.assertIsNotNone(fd)
                os.close(fd)
            finally:
                if proc.poll() is None: proc.kill(); proc.wait()
                if pid:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_exit_code_and_job_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, str(SCRIPT), "--job", "fixture", "--",
                sys.executable, "-c", "raise SystemExit(7)"], env=dict(os.environ, HOME=tmp),
                capture_output=True, text=True)
            self.assertEqual(result.returncode, 7)
            row = json.loads((Path(tmp) / ".ashlr-runs/queue/heavy/events.jsonl").read_text())
            self.assertEqual(row["job"], "fixture")
            self.assertGreaterEqual(row["wait_s"], 0)
            self.assertGreaterEqual(row["run_s"], 0)

    def test_status_fixture_cpu_classes(self):
        source = SCRIPT.with_name("dispatchd.py")
        tree = ast.parse(source.read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "cpu_by_class")
        rows = "1 120 node\n2 10 bun\n3 3 cargo\n4 4 node\n5 5 codex\n6 6 ollama\n7 7 launchd\n"
        import re
        env = dict(os=os, re=re, subprocess=types.SimpleNamespace(
            run=lambda *a, **kw: types.SimpleNamespace(returncode=0, stdout=rows),
            TimeoutExpired=subprocess.TimeoutExpired))
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), env)
        st = next(n.value for n in tree.body if isinstance(n, ast.Assign) and
                  any(isinstance(t, ast.Name) and t.id == "st" for t in n.targets))
        sample = next(v for k, v in zip(st.keys, st.values) if k.value == "machine_sample")
        env["ps"] = "1 node node_modules/typescript/bin/tsc --noEmit"
        status = {"machine_sample": eval(compile(ast.Expression(sample), str(source), "eval"), env)}
        self.assertEqual(status["machine_sample"]["cpu_by_class"],
            dict(tsc=120, bun=10, cargo=3, node=4, codex=5, **{"omlx/ollama": 6, "other": 7}))
        env["subprocess"].run = lambda *a, **kw: types.SimpleNamespace(returncode=1, stdout="")
        self.assertIsNone(env["cpu_by_class"](""))


if __name__ == "__main__":
    unittest.main()
