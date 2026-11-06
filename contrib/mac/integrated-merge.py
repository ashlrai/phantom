#!/usr/bin/env python3
"""Read-only proof check for an already-integrated, original bridge PR.

Only the existing publisher may push. This helper emits five identifiers after
checking a private, short-lived operator receipt, its reconciliation evidence,
the real Git history and fresh GitHub metadata. Tree equality alone is not
semantic evidence that the original contribution was retained.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time

REPOS = frozenset(("phantom", "phantom-secrets", "lexicon", "locus",
                   "ashlr-stack", "ashlr-md", "ashlr-plugin"))
GS_SHA = "234fb12a57a51fdfed81da8702a0b452c183f2726582608b81b7e811a65ce1a2"
PROBE_SECONDS = 30
HEX = re.compile(r"[0-9a-f]{40}\Z")
JOB = re.compile(r"[A-Za-z0-9._-]+\Z")


class Refused(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def private_file(path, parent, limit):
    """No links or worker-writable custody, even for a correctly shaped proof."""
    parent = Path(parent)
    path = Path(path)
    require(path.parent == parent, "unexpected proof directory")
    ps = parent.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe proof directory")
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()
            and stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1
            and st.st_size <= limit, "unsafe proof file")
    # O_NOFOLLOW and fstat also reject a substitution between lstat and open.
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        current = os.fstat(stream.fileno())
        require((current.st_dev, current.st_ino) == (st.st_dev, st.st_ino),
                "proof changed while opening")
        require(stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid()
                and stat.S_IMODE(current.st_mode) == 0o600
                and current.st_nlink == 1 and current.st_size <= limit,
                "proof custody changed while opening")
        data = stream.read(limit + 1)
    require(len(data) <= limit, "oversized proof")
    return data


def decode(data):
    value = json.loads(data, object_pairs_hook=no_duplicate_keys)
    require(type(value) is dict, "proof must be an object")
    return value


def validate_receipt(r, job, repo, base, now):
    keys = {"schema", "job", "repo", "pr", "originalHead", "mainHead",
            "mergeHead", "tree", "createdAt", "expiresAt", "evidenceSha256"}
    require(set(r) == keys and type(r["schema"]) is int and r["schema"] == 1,
            "unexpected receipt schema")
    require(JOB.fullmatch(job) is not None and ".." not in job, "invalid job")
    require(repo in REPOS and r["repo"] == repo and r["job"] == job,
            "receipt job/repository mismatch")
    require(type(r["pr"]) is int and r["pr"] > 0, "invalid original PR")
    for key in ("originalHead", "mainHead", "mergeHead", "tree"):
        require(type(r[key]) is str and HEX.fullmatch(r[key]) is not None,
                "invalid pinned Git object")
    require(r["mainHead"] == base, "base must be pinned current main")
    require(len({r["originalHead"], r["mainHead"], r["mergeHead"]}) == 3,
            "merge must preserve two distinct histories")
    created, expires = r["createdAt"], r["expiresAt"]
    require(type(created) is int and type(expires) is int
            and 0 < expires - created <= 1800
            and created <= now < expires and now - created <= 1800,
            "expired or invalid receipt window")
    require(type(r["evidenceSha256"]) is str
            and re.fullmatch(r"[0-9a-f]{64}", r["evidenceSha256"]) is not None,
            "invalid evidence digest")


def validate_evidence(e, r, changed_paths):
    keys = {"schema", "repo", "pr", "originalHead", "mainHead", "mergeHead",
            "reviewedTree", "outcome", "reviewer", "paths"}
    require(set(e) == keys and type(e["schema"]) is int and e["schema"] == 1,
            "unexpected evidence schema")
    for key in ("repo", "pr", "originalHead", "mainHead", "mergeHead"):
        require(e[key] == r[key], "evidence pins do not match receipt")
    require(e["reviewedTree"] == r["tree"]
            and e["outcome"] == "already-integrated", "unreviewed final tree")
    require(type(e["reviewer"]) is str and e["reviewer"].strip(),
            "named reconciliation reviewer required")
    require(type(e["paths"]) is list and e["paths"],
            "per-path reconciliation required")
    covered = []
    for item in e["paths"]:
        require(type(item) is dict and set(item) == {
            "path", "originalChange", "mainEvidence", "verification"},
            "unexpected path evidence schema")
        require(all(type(x) is str and x.strip() for x in item.values()),
                "incomplete path reconciliation")
        covered.append(item["path"])
    require(len(covered) == len(set(covered))
            and set(covered) == set(changed_paths),
            "evidence must account for every original changed path")


def validate_remote(r, repository, fork, pr):
    upstream = "ashlrai/" + r["repo"]
    downstream = "masonwyatt23/" + r["repo"]
    require(repository.get("full_name") == upstream,
            "upstream redirect or repository mismatch")
    default = repository.get("default_branch")
    require(type(default) is str and default in ("main", "master"),
            "unexpected default branch")
    require(fork.get("full_name") == downstream and fork.get("fork") is True
            and (fork.get("parent") or {}).get("full_name") == upstream,
            "fork target mismatch")
    require(pr.get("number") == r["pr"] and pr.get("state") == "open"
            and pr.get("merged_at") is None, "original PR is not open")
    head, base = pr.get("head") or {}, pr.get("base") or {}
    require((head.get("repo") or {}).get("full_name") == downstream
            and head.get("ref") == "codex-bridge/" + r["job"]
            and head.get("sha") == r["originalHead"],
            "original PR head changed or wrong owner")
    require((base.get("repo") or {}).get("full_name") == upstream
            and base.get("ref") == default, "original PR base mismatch")
    return default


def validate_git(r, facts):
    require(facts["head"] == r["mergeHead"], "authored merge changed")
    require(facts["parents"] == [r["originalHead"], r["mainHead"]],
            "merge must have exactly original/main parents in that order")
    require(facts["tree"] == facts["mainTree"] == facts["indexTree"] == r["tree"],
            "merge/index tree differs from reviewed current main")
    require(facts["trackedClean"] and not facts["extraFiles"],
            "unreviewed worktree changes")


class Runtime:
    def __init__(self, root, wt):
        self.root, self.wt = Path(root), str(wt)
        self.gs = self.root / "bin/git-safe-env.sh"
        require(not self.gs.is_symlink() and self.gs.is_file()
                and hashlib.sha256(self.gs.read_bytes()).hexdigest() == GS_SHA,
                "pinned Git helper unavailable")

    def command(self, args):
        child = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True,
            env={k: v for k, v in os.environ.items()
                 if not (k.startswith("GIT_") or k in
                         ("BASH_ENV", "ENV", "CDPATH"))})
        try:
            stdout, _ = child.communicate(timeout=PROBE_SECONDS)
        except subprocess.TimeoutExpired:
            # Same own-probe cleanup pattern as process_snapshot._bounded.
            # A subprocess.run timeout can hang on a grandchild's inherited
            # stdout. This freshly created probe group never contains workers.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                child.communicate(timeout=0.1)
            except subprocess.TimeoutExpired:
                child.stdout.close()
            raise Refused("proof query timed out") from None
        require(child.returncode == 0, "proof query failed")
        require(len(stdout) <= 4 * 1024 * 1024, "oversized proof query")
        return stdout.decode("utf-8")

    def api(self, route):
        return decode(self.command(["/opt/homebrew/bin/gh", "api", "--hostname",
                                    "github.com", route]).encode())

    def facts(self, r):
        # Scan the worktree once per proof, rather than repeatedly traversing a
        # large node_modules tree. All Git execution still uses the pinned helper.
        script = '''set -eu
. "$1"; gs_init; gs_check "$2" >/dev/null
gs_git "$2" rev-parse --git-common-dir > "$5/common"
gs_git "$2" status --porcelain=v1 -uall > "$5/status"
gs_git "$2" rev-parse HEAD > "$5/head"
gs_git "$2" rev-list --parents -n1 HEAD > "$5/parents"
gs_git "$2" rev-parse 'HEAD^{tree}' > "$5/tree"
gs_git "$2" rev-parse "$4^{tree}" > "$5/mainTree"
gs_git "$2" write-tree > "$5/indexTree"
ancestor=$(gs_git "$2" merge-base "$3" "$4")
gs_git "$2" diff --no-ext-diff --no-textconv --name-only -z "$ancestor" "$3" > "$5/paths"
'''
        with tempfile.TemporaryDirectory(prefix="integrated-proof-", dir=self.root) as td:
            self.command(["/bin/bash", "--noprofile", "--norc", "-c", script,
                          "--", str(self.gs), self.wt, r["originalHead"],
                          r["mainHead"], td])
            def read(name):
                data = (Path(td) / name).read_bytes()
                require(len(data) <= 4 * 1024 * 1024, "oversized Git proof")
                return data.decode("utf-8")
            extra = [line for line in read("status").splitlines()
                     if line != "?? BRIDGE_NOTES.md"]
            changed = read("paths")
            return {
                "common": read("common").strip(),
                "head": read("head").strip(),
                "parents": read("parents").split()[1:],
                "tree": read("tree").strip(),
                "mainTree": read("mainTree").strip(),
                "indexTree": read("indexTree").strip(),
                "trackedClean": not extra, "extraFiles": extra,
                "changedPaths": changed.rstrip("\0").split("\0") if changed else [],
            }


def verify(root, job, base, wt):
    require(JOB.fullmatch(job) is not None and ".." not in job, "invalid job")
    root = Path(root)
    directory = root / "integrated-merge"
    receipt = decode(private_file(directory / (job + ".json"), directory, 16384))
    require(type(receipt.get("repo")) is str, "missing repository")
    repo = receipt["repo"]
    validate_receipt(receipt, job, repo, base, int(time.time()))
    # Match the publisher's queue record and common-dir authority, never origin.
    line_path = root / "queue/run" / (job + ".line")
    st = line_path.lstat()
    require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid(),
            "unsafe job record")
    columns = line_path.read_text().splitlines()[0].split("\t")
    require(columns[:2] == [job, repo], "job record mismatch")
    runtime = Runtime(root, wt)
    expected = Path.home() / "Projects/ashlrai" / repo / ".git"
    facts = runtime.facts(receipt)
    actual = Path(wt) / facts["common"]
    require(actual.resolve() == expected.resolve(), "worktree repository mismatch")
    validate_git(receipt, facts)
    notes = Path(wt) / "BRIDGE_NOTES.md"
    if notes.exists() or notes.is_symlink():
        ns = notes.lstat()
        require(stat.S_ISREG(ns.st_mode) and ns.st_uid == os.getuid()
                and ns.st_nlink == 1 and ns.st_size <= 65536,
                "unsafe bridge notes")
    evidence_dir = directory / "evidence"
    raw = private_file(evidence_dir / (job + ".json"), evidence_dir, 1024 * 1024)
    require(hashlib.sha256(raw).hexdigest() == receipt["evidenceSha256"],
            "reconciliation evidence changed")
    validate_evidence(decode(raw), receipt, facts["changedPaths"])
    repository = runtime.api("repos/ashlrai/" + repo)
    fork = runtime.api("repos/masonwyatt23/" + repo)
    pr = runtime.api("repos/ashlrai/" + repo + "/pulls/" + str(receipt["pr"]))
    default = validate_remote(receipt, repository, fork, pr)
    branch = runtime.api("repos/ashlrai/" + repo + "/branches/" + default)
    require((branch.get("commit") or {}).get("sha") == receipt["mainHead"],
            "current default head advanced; reconcile again")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--worktree", required=True)
    args = parser.parse_args()
    try:
        r = verify(Path.home() / ".ashlr-runs", args.job, args.base, args.worktree)
        print(" ".join((str(r["pr"]), r["mainHead"], r["originalHead"],
                        r["mergeHead"], r["tree"])))
    except (Refused, OSError, ValueError, KeyError, IndexError,
            subprocess.SubprocessError):
        # Private reconciliation text and remote responses never enter run logs.
        print("integrated merge proof refused", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
