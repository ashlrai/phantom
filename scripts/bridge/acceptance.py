#!/usr/bin/env python3
"""Twenty real local fixture launches; never launches a provider or publishes."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("bridge_disk", Path(__file__).with_name("disk.py"))
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()


def qualify(report):
    if sys.platform != "darwin":
        raise RuntimeError("Native APFS acceptance requires macOS")
    with tempfile.TemporaryDirectory(prefix="bridge-disk-acceptance-") as temporary:
        root = Path(temporary).resolve()
        source, state = root / "source", root / "state"
        source.mkdir()
        git(source, "init", "-b", "main")
        git(source, "config", "user.email", "fixture@example.invalid")
        git(source, "config", "user.name", "Disk fixture")
        git(source, "config", "core.hooksPath", "/dev/null")
        git(source, "remote", "add", "origin", "https://github.com/ashlrai/phantom.git")
        (source / ".gitignore").write_text("node_modules/\n")
        (source / "package.json").write_text('{"name":"disk-fixture","private":true}\n')
        (source / "package-lock.json").write_text('{"lockfileVersion":3}\n')
        git(source, "add", ".")
        git(source, "commit", "-qm", "isolated fixture")
        modules = source / "node_modules"
        modules.mkdir()
        # Ordinary copying twenty times would exceed 5 GiB. Allocate real,
        # incompressible bytes before the baseline; sparse files prove nothing.
        block = os.urandom(1024**2)
        with (modules / "payload.bin").open("wb") as stream:
            for _ in range(320):
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
        before = shutil.disk_usage(root).free
        worktrees = []
        targets = set()
        for index in range(20):
            worktree = root / ("run-" + str(index))
            git(source, "worktree", "add", "--detach", str(worktree), "HEAD")
            code = disk.launch(source, worktree, state, "fixture-" + str(index), [
                sys.executable, "-I", "-c",
                "import os,pathlib; p=pathlib.Path(os.environ['CARGO_TARGET_DIR']); "
                "(p/'fixture-cache').write_bytes(b'cached'); pathlib.Path('target-path').write_text(str(p))",
            ])
            if code != 0 or (worktree / "node_modules").is_symlink():
                raise RuntimeError("Launch did not produce independent cloned dependencies")
            targets.add((worktree / "target-path").read_text())
            worktrees.append(worktree)
        after = shutil.disk_usage(root).free
        growth = before - after
        accepted = growth < 5 * 1024**3 and len(targets) == 1
        evidence = {"fixture_only": True, "launches": 20, "source_payload_bytes": 320 * 1024**2,
                    "before_free_bytes": before, "after_free_bytes": after, "growth_bytes": growth,
                    "shared_target_count": len(targets), "under_5_gib": accepted}
        for index, worktree in enumerate(worktrees):
            disk.finish(worktree, state, "fixture-" + str(index), {
                "url": "https://github.com/ashlrai/phantom/pull/1",
                "head_oid": git(source, "rev-parse", "HEAD"), "observed_at": time.time(),
            })
        records = [json.loads(line) for line in (state / "disk.log").read_text().splitlines()]
        evidence["removed_worktrees"] = sum(row["event"] == "publish-removed" for row in records)
        evidence["disk_records"] = len(records)
        evidence["records"] = records
        report.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({name: value for name, value in evidence.items() if name != "records"}))
        return 0 if accepted and evidence["removed_worktrees"] == 20 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    sys.exit(qualify(parser.parse_args().report))
