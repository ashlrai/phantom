#!/usr/bin/env python3
"""Offline three-way PR evidence. This never closes, queues, or merges a PR."""
import argparse
import collections
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

OID = re.compile(r"[0-9a-f]{40}")
MAX_INPUT_BYTES = 262_144
MAX_ROWS = 1000
BATCH = 50
MAX_REPLY_BYTES = 8 * 1024 * 1024


def load_snapshot(path):
    with path.open("rb") as handle:
        data = handle.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("snapshot too large")
    rows = json.loads(data)
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError("snapshot must contain 1–1000 rows")
    numbers = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"number", "headSha"}:
            raise ValueError("expected number and headSha")
        number, oid = row["number"], row["headSha"]
        if type(number) is not int or not 1 <= number <= 2**53 - 1 or number in numbers:
            raise ValueError("snapshot PR number invalid or repeated")
        if not isinstance(oid, str) or not OID.fullmatch(oid):
            raise ValueError("expected a full lowercase SHA-1 head")
        numbers.add(number)
    return rows


def git_env():
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return dict(env, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1",
                GIT_OPTIONAL_LOCKS="0")


def parse_records(raw, expected, base_tree):
    # --stdin exits zero even for conflicts. -z + --no-messages ends each
    # result with two NUL bytes; a conflict has at least one named path.
    if not raw.endswith(b"\0\0"):
        raise ValueError("incomplete merge-tree output")
    records = raw[:-2].split(b"\0\0")
    if len(records) != expected:
        raise ValueError("merge-tree record count mismatch")
    parsed = []
    for record in records:
        fields = record.split(b"\0")
        if len(fields) < 2 or not re.fullmatch(rb"[0-9a-f]{40}", fields[1]):
            raise ValueError("invalid merge-tree oid")
        status, tree = fields[:2]
        if status == b"1" and len(fields) == 2:
            parsed.append(("no-file-change" if tree == base_tree else "clean-file-change", 0))
        elif status == b"0" and len(fields) > 2:
            parsed.append(("conflicting", len(fields) - 2))
        else:
            raise ValueError("invalid merge-tree status")
    return parsed


def classify(repo, base, rows):
    env = git_env()

    def run(argv, data=None, limit=10):
        return subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, *argv],
                              input=data, capture_output=True, env=env, timeout=limit, check=True).stdout

    objects = run(["-C", str(repo), "rev-parse", "--path-format=absolute", "--git-path", "objects"])
    if not objects.endswith(b"\n") or b"\n" in objects[:-1] or b"\r" in objects:
        raise ValueError("unsupported repository path")
    with tempfile.TemporaryDirectory(prefix="phm-pr-trees-") as directory:
        scratch = Path(directory) / "sandbox.git"
        run(["init", "--bare", "--quiet", "--object-format=sha1", str(scratch)])
        (scratch / "objects" / "info" / "alternates").write_bytes(objects)
        args = ["--git-dir", str(scratch)]
        base_tree = run([*args, "rev-parse", "--verify", base + "^{tree}"]).strip()
        # Missing objects must be unknown for their own PR, not poison a batch.
        refs = [base, *[row["headSha"] for row in rows]]
        listed = run([*args, "cat-file", "--batch-check"],
                     ("\n".join(refs) + "\n").encode()).splitlines()
        if len(listed) != len(refs) or not listed[0].startswith(base.encode() + b" commit "):
            raise ValueError("base is unavailable or not an exact commit")
        known = [line.startswith(ref.encode() + b" commit ")
                 for ref, line in zip(refs[1:], listed[1:], strict=True)]
        output = [dict(row, verdict="unknown", conflictPaths=None) for row in rows]
        ready = [i for i, ok in enumerate(known) if ok]
        for offset in range(0, len(ready), BATCH):
            batch = ready[offset:offset + BATCH]
            data = "".join(f"{base} {rows[i]['headSha']}\n" for i in batch).encode()
            try:
                with tempfile.TemporaryFile(dir=directory) as receipt:
                    subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, *args, "merge-tree",
                                    "--write-tree", "--stdin", "-z", "--name-only", "--no-messages"],
                                   input=data, stdout=receipt, stderr=subprocess.DEVNULL,
                                   env=env, timeout=15, check=True)
                    receipt.seek(0)
                    raw = receipt.read(MAX_REPLY_BYTES + 1)
                if len(raw) > MAX_REPLY_BYTES:
                    continue
                parsed = parse_records(raw, len(batch), base_tree)
            except (ValueError, subprocess.SubprocessError):
                continue
            for i, (verdict, paths) in zip(batch, parsed, strict=True):
                output[i].update(verdict=verdict, conflictPaths=paths)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="explicit local Git object source")
    parser.add_argument("--base", required=True, help="frozen full master SHA")
    parser.add_argument("--snapshot", type=Path, required=True,
                        help='JSON array of {"number":123,"headSha":"<40 lowercase hex>"}')
    args = parser.parse_args()
    try:
        if not OID.fullmatch(args.base):
            raise ValueError("expected a full lowercase SHA-1 base")
        started = time.monotonic()
        rows = classify(args.repo, args.base, load_snapshot(args.snapshot))
        print(json.dumps({"schema": "phm.pr-tree-triage.v1", "baseSha": args.base,
                          "checked": len(rows), "complete": all(row["verdict"] != "unknown" for row in rows),
                          "elapsedSeconds": round(time.monotonic() - started, 3),
                          "counts": dict(collections.Counter(row["verdict"] for row in rows)), "prs": rows}))
    except (OSError, ValueError, subprocess.SubprocessError):
        print("pr-tree-triage: invalid snapshot or unavailable local Git evidence", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
