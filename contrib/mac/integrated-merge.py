#!/usr/bin/env python3
"""Read-only proof check for an already-integrated, original bridge PR.

Only the existing publisher may push. This helper emits five identifiers after
checking a private, short-lived operator receipt, its reconciliation evidence,
the real Git history and fresh GitHub metadata. Tree equality alone is not
semantic evidence that the original contribution was retained.
"""
import argparse
import hashlib
import fcntl
import secrets
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


# Closed reviewed upstream-feature tuples; identities, not a routing table.
# Each entry binds one original PR to its canonical repository, exact feature
# ref, immutable original head and the literal push argv used after every guard.
UPSTREAM_TUPLES = {
    "upstream-original157": {
        "repo": "ashlr-plugin", "pr": 157,
        "headRepo": "ashlrai/ashlr-plugin", "headRef": "feat/read-range",
        "originalHead": "0837489ab7bb6b8801884108f8932367d10f68b1",
        "branchApi": "feat%2Fread-range",
        "attemptFile": "upstream-original157.attempt",
        "lockFile": "upstream-original157.outcome-lock",
        "launchFile": "upstream-original157.launch",
        "pushLine": ' gs_git "$2" push --force-with-lease=refs/heads/feat/read-range:0837489ab7bb6b8801884108f8932367d10f68b1 https://github.com/ashlrai/ashlr-plugin.git "$3:refs/heads/feat/read-range"',
    },
    "upstream-lexicon479": {
        "repoId": 1376859455,
        "repo": "lexicon", "pr": 479,
        "headRepo": "ashlrai/lexicon",
        "headRef": "dependabot/github_actions/actions/download-artifact-8",
        "originalHead": "3b7c93ff552d3fa7a5b835a416c238c37be78cdd",
        "branchApi": "dependabot%2Fgithub_actions%2Factions%2Fdownload-artifact-8",
        "attemptFile": "upstream-lexicon479.attempt",
        "lockFile": "upstream-lexicon479.outcome-lock",
        "launchFile": "upstream-lexicon479.launch",
        "pushLine": ' gs_git "$2" push --force-with-lease=refs/heads/dependabot/github_actions/actions/download-artifact-8:3b7c93ff552d3fa7a5b835a416c238c37be78cdd https://github.com/ashlrai/lexicon.git "$3:refs/heads/dependabot/github_actions/actions/download-artifact-8"',
    },
    "upstream-lexicon480": {
        "repoId": 1376859455,
        "repo": "lexicon", "pr": 480,
        "headRepo": "ashlrai/lexicon",
        "headRef": "dependabot/github_actions/actions/cache-6",
        "originalHead": "f6975814f2ae2b562c81c57e50c5ecdeb05627d6",
        "branchApi": "dependabot%2Fgithub_actions%2Factions%2Fcache-6",
        "attemptFile": "upstream-lexicon480.attempt",
        "lockFile": "upstream-lexicon480.outcome-lock",
        "launchFile": "upstream-lexicon480.launch",
        "pushLine": ' gs_git "$2" push --force-with-lease=refs/heads/dependabot/github_actions/actions/cache-6:f6975814f2ae2b562c81c57e50c5ecdeb05627d6 https://github.com/ashlrai/lexicon.git "$3:refs/heads/dependabot/github_actions/actions/cache-6"',
    },
}


def upstream_tuple(r):
    """Return (profile, tuple) only when every bound identity field matches."""
    profile = r.get("profile") if type(r) is dict else None
    t = UPSTREAM_TUPLES.get(profile)
    require(t is not None and r.get("repo") == t["repo"] and r.get("pr") == t["pr"]
            and r.get("headRepo") == t["headRepo"] and r.get("headRef") == t["headRef"]
            and r.get("originalHead") == t["originalHead"], "wrong upstream profile")
    return profile, t


def validate_upstream_receipt(r, job, repo, base, now):
    require(set(r) == {"schema", "job", "repo", "pr", "originalHead", "mainHead",
                       "mergeHead", "tree", "createdAt", "expiresAt", "evidenceSha256",
                       "profile", "headRepo", "headRef"}
            and type(r["schema"]) is int and r["schema"] == 2,
            "unexpected receipt schema")
    upstream_tuple(r)
    legacy = {k: v for k, v in r.items() if k not in ("profile", "headRepo", "headRef")}
    legacy["schema"] = 1
    validate_receipt(legacy, job, repo, base, now)


def decode_rules(data):
    value = json.loads(data, object_pairs_hook=no_duplicate_keys)
    require(type(value) is list, "branch rules must be an array")
    return value


def http_split(raw):
    """Split `gh api --include` output into (status, body).

    The status line is mandatory: without it the HTTP result is unknown and
    callers must treat the exchange as ambiguous, never as success.
    """
    head, sep, body = raw.partition("\r\n\r\n")
    if not sep:
        head, sep, body = raw.partition("\n\n")
    require(sep, "HTTP header boundary missing")
    first = head.split("\n", 1)[0].strip()
    match = re.match(r"HTTP/\S+\s+(\d{3})(?:\s|$)", first)
    require(match is not None, "HTTP status line missing")
    return int(match.group(1)), body


def validate_upstream_repository_ids(t, repository, head_repository, base_repository):
    # Lex recovery binds the immutable repository ID, not just a reusable name.
    # The held original157 profile and legacy fork path retain their old contract.
    if "repoId" not in t:
        return
    require(all(type(value) is dict and type(value.get("id")) is int
                and value["id"] == t["repoId"]
                for value in (repository, head_repository, base_repository)),
            "upstream repository ID changed or unavailable")


def validate_terminal_lexicon_join(runtime, api, r, t, merged):
    if "repoId" not in t:
        return
    joined = runtime.api(api + "/git/commits/" + r["mergeHead"])
    require(joined.get("sha") == r["mergeHead"]
            and (joined.get("tree") or {}).get("sha") == r["tree"]
            and type(joined.get("parents")) is list
            and [p.get("sha") if type(p) is dict else None for p in joined["parents"]]
                == [r["originalHead"], r["mainHead"]],
            "terminal original ordered join not proven")
    # Lex-only, explicit SQUASH contract: the original PR retains the authored
    # ordered join; canonical main retains its exact already-integrated tree.
    # This is not a claim that the authored join is a canonical ancestor.
    parents = merged.get("parents")
    require(type(parents) is list and len(parents) == 1
            and type(parents[0]) is dict
            and parents[0].get("sha") == r["mainHead"],
            "terminal squash parent differs from reviewed main")


def validate_upstream_remote(r, repository, pr, default_branch, feature_branch, rules, post=False):
    _, t = upstream_tuple(r)
    require(repository.get("full_name") == t["headRepo"]
            and repository.get("default_branch") == "main", "unexpected upstream default")
    require(default_branch.get("name") == "main" and default_branch.get("protected") is True
            and (default_branch.get("commit") or {}).get("sha") == r["mainHead"],
            "default branch is not the pinned protected main")
    expected = r["mergeHead"] if post else t["originalHead"]
    require(pr.get("number") == t["pr"] and pr.get("state") == "open"
            and "merged_at" in pr and pr["merged_at"] is None, "original PR is not open")
    head, base = pr.get("head") or {}, pr.get("base") or {}
    validate_upstream_repository_ids(t, repository, head.get("repo"), base.get("repo"))
    require((head.get("repo") or {}).get("full_name") == t["headRepo"]
            and head.get("ref") == t["headRef"] and head.get("sha") == expected
            and (base.get("repo") or {}).get("full_name") == t["headRepo"]
            and base.get("ref") == "main", "original PR identity changed")
    require(feature_branch.get("name") == t["headRef"]
            and feature_branch.get("protected") is False
            and (feature_branch.get("commit") or {}).get("sha") == expected
            and type(rules) is list and rules == [], "feature branch protection or head unknown")
    return "main"


def validate_admission(r, rules, pr, prospective):
    """Require the entire prospective merge tree and ordered parent identities."""
    merge_sha = pr.get("merge_commit_sha")
    require(pr.get("mergeable") is True and type(merge_sha) is str
            and HEX.fullmatch(merge_sha) is not None,
            "prospective merge unavailable")
    require(prospective.get("sha") == merge_sha
            and (prospective.get("tree") or {}).get("sha") == r["tree"],
            "prospective merge tree differs")
    parents = prospective.get("parents")
    require(type(parents) is list and len(parents) == 2
            and all(type(parent) is dict for parent in parents)
            and [parent.get("sha") for parent in parents] == [r["mainHead"], r["mergeHead"]],
            "prospective merge parents changed")
    return merge_sha

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
    def __init__(self, root, wt=None):
        self.root, self.wt = Path(root), None if wt is None else str(wt)
        self.gs = self.root / "bin/git-safe-env.sh"
        require(not self.gs.is_symlink() and self.gs.is_file()
                and hashlib.sha256(self.gs.read_bytes()).hexdigest() == GS_SHA,
                "pinned Git helper unavailable")

    def _probe(self, args):
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
        require(len(stdout) <= 4 * 1024 * 1024, "oversized proof query")
        return child.returncode, stdout.decode("utf-8")

    def command(self, args):
        rc, out = self._probe(args)
        require(rc == 0, "proof query failed")
        return out

    def api(self, route):
        return decode(self.command(["/opt/homebrew/bin/gh", "api", "--hostname",
                                    "github.com", route]).encode())

    def api_http(self, route, fields=None):
        """One bounded gh api call; returns (returncode, http_status, body).

        --include puts the real status line ahead of headers and body so a
        404 absence proof, a 201 creation and 409/422 conflicts stay distinct.
        body is the decoded JSON value or None when absent/unparseable.
        """
        args = ["/opt/homebrew/bin/gh", "api", "--hostname", "github.com",
                "--include", route]
        if fields is not None:
            args += ["--method", "POST"]
            for key, value in fields:
                args += ["--raw-field", key + "=" + value]
        rc, raw = self._probe(args)
        status, body = http_split(raw)
        value = None
        if body.strip():
            try:
                value = json.loads(body, object_pairs_hook=no_duplicate_keys)
            except ValueError:
                value = None
        return rc, status, value

    def rules(self, route):
        return decode_rules(self.command(["/opt/homebrew/bin/gh", "api", "--hostname",
                                          "github.com", route]).encode())

    def facts(self, r, upstream=False):
        # Scan the worktree once per proof, rather than repeatedly traversing a
        # large node_modules tree. All Git execution still uses the pinned helper.
        script = r'''set -eu
. "$1"; gs_init; gs_check "$2" >/dev/null
gs_git "$2" rev-parse --git-common-dir > "$5/common"
if [ "$6" = strict ]; then
  set -o pipefail
  gs_git "$2" status --porcelain=v1 -uall --ignored > "$5/status"
  # A hidden index entry can conceal worktree dirt from status; refuse it.
  gs_git "$2" ls-files -v -z | /usr/bin/perl -0ne 'exit 1 unless /^H /' || exit 1
  /usr/bin/perl -ne 'exit 1 unless /^\?\? BRIDGE_NOTES\.md\n\z/' "$5/status" || exit 1
else
  gs_git "$2" status --porcelain=v1 -uall > "$5/status"
fi
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
                          r["mainHead"], td, "strict" if upstream else "legacy"])
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


def verify(root, job, base, wt, upstream=False, post=False, local_only=False):
    require(JOB.fullmatch(job) is not None and ".." not in job, "invalid job")
    root = Path(root)
    directory = root / "integrated-merge"
    receipt = decode(private_file(directory / (job + ".json"), directory, 16384))
    require(type(receipt.get("repo")) is str, "missing repository")
    repo = receipt["repo"]
    if upstream:
        validate_upstream_receipt(receipt, job, repo, base, int(time.time()))
    else:
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
    facts = runtime.facts(receipt, upstream=upstream) if upstream else runtime.facts(receipt)
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
    if local_only:
        return receipt
    repository = runtime.api("repos/ashlrai/" + repo)
    pr = runtime.api("repos/ashlrai/" + repo + "/pulls/" + str(receipt["pr"]))
    if upstream:
        _, t = upstream_tuple(receipt)
        api = "repos/" + t["headRepo"]
        branch = runtime.api(api + "/branches/main")
        feature = runtime.api(api + "/branches/" + t["branchApi"])
        rules = runtime.rules(api + "/rules/branches/" + t["branchApi"])
        validate_upstream_remote(receipt, repository, pr, branch, feature, rules, post)
    else:
        fork = runtime.api("repos/masonwyatt23/" + repo)
        default = validate_remote(receipt, repository, fork, pr)
        branch = runtime.api("repos/ashlrai/" + repo + "/branches/" + default)
        require((branch.get("commit") or {}).get("sha") == receipt["mainHead"],
                "current default head advanced; reconcile again")
    return receipt


def journal_binding(r):
    raw = json.dumps(r, sort_keys=True, separators=(",", ":")).encode()
    return {"schema": 1, "receiptSha256": hashlib.sha256(raw).hexdigest(),
            **{k: r[k] for k in ("job", "originalHead", "mainHead", "mergeHead", "tree", "evidenceSha256")}}


def journal_read(root, r):
    _, t = upstream_tuple(r)
    directory = Path(root) / "integrated-merge"
    path = directory / t["attemptFile"]
    value = decode(private_file(path, directory, 4096))
    binding = journal_binding(r)
    require(set(value) == set(binding) | {"state", "tokenSha256"} and
            all(value[k] == v for k, v in binding.items()) and
            type(value["tokenSha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", value["tokenSha256"]) is not None and
            value["state"] in ("ATTEMPTED", "HELD", "REQUESTED", "QUEUED", "MERGED"),
            "attempt custody or binding mismatch")
    return value


def journal_attempt(root, r):
    _, t = upstream_tuple(r)
    directory = Path(root) / "integrated-merge"
    ps = directory.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe attempt directory")
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        require((current.st_dev, current.st_ino) == (ps.st_dev, ps.st_ino), "directory changed")
        try:
            f = os.open(t["attemptFile"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        except FileExistsError:
            journal_read(root, r)
            return "EXISTING"
        try:
            token = secrets.token_hex(32)
            data = json.dumps({**journal_binding(r), "state": "ATTEMPTED", "tokenSha256": hashlib.sha256(token.encode()).hexdigest()}, sort_keys=True).encode()
            require(os.write(f, data) == len(data), "short journal write")
            os.fsync(f)
        finally:
            os.close(f)
        os.fsync(fd)
        return "CREATED " + token
    finally:
        os.close(fd)


def record_outcome(root, r, status):
    _, t = upstream_tuple(r)
    directory = Path(root) / "integrated-merge"
    ps = directory.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe outcome directory")
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        ds = os.fstat(fd)
        require((ds.st_dev, ds.st_ino) == (ps.st_dev, ps.st_ino), "outcome directory changed")
        lock = os.open(t["lockFile"], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        ls = os.fstat(lock)
        require(stat.S_ISREG(ls.st_mode) and ls.st_uid == os.getuid()
                and stat.S_IMODE(ls.st_mode) == 0o600 and ls.st_nlink == 1, "unsafe outcome lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _record_outcome_locked(root, r, status)
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def _record_outcome_locked(root, r, status):
    require(status in ("HELD", "REQUESTED", "QUEUED", "MERGED"), "bad outcome")
    _, t = upstream_tuple(r)
    prior = journal_read(root, r)
    require(prior["state"] != "MERGED" or status == "MERGED", "terminal outcome")
    directory = Path(root) / "integrated-merge"
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = "." + t["attemptFile"] + "." + os.urandom(16).hex()
    try:
        f = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            data = json.dumps({**journal_binding(r), "state": status, "tokenSha256": prior["tokenSha256"]}, sort_keys=True).encode()
            require(os.write(f, data) == len(data), "short outcome write")
            os.fsync(f)
        finally:
            os.close(f)
        require(journal_read(root, r) == prior, "attempt changed")
        os.replace(name, t["attemptFile"], src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def prepare(root, job, base, wt):
    r = verify(root, job, base, wt, upstream=True, local_only=True)
    _, t = upstream_tuple(r)
    attempt = Path(root) / "integrated-merge" / t["attemptFile"]
    if attempt.exists() or attempt.is_symlink():
        journal_read(root, r)
        return r
    return verify(root, job, base, wt, upstream=True)


def admission(root, job, base, wt):
    r = verify(root, job, base, wt, upstream=True, post=True)
    journal_read(root, r)
    _, t = upstream_tuple(r)
    runtime = Runtime(root, wt)
    api = "repos/" + t["headRepo"]
    route = api + "/pulls/" + str(t["pr"])
    pr = runtime.api(route)
    target = pr.get("base") or {}
    require(target.get("sha") == r["mainHead"], "prospective base changed")
    merge_sha = pr.get("merge_commit_sha")
    require(type(merge_sha) is str and HEX.fullmatch(merge_sha), "prospective merge unavailable")
    prospective = runtime.api(api + "/git/commits/" + merge_sha)
    validate_admission(r, None, pr, prospective)
    require(verify(root, job, base, wt, upstream=True, post=True) == r, "proof changed")
    final_pr = runtime.api(route)
    require((final_pr.get("base") or {}).get("sha") == r["mainHead"], "base changed")
    require(validate_admission(r, None, final_pr, prospective) == merge_sha, "prospective merge changed")
    return r


def outcome(root, job, base, wt):
    r = verify(root, job, base, wt, upstream=True, local_only=True)
    journal_read(root, r)
    _, t = upstream_tuple(r)
    runtime = Runtime(root, wt)
    api = "repos/" + t["headRepo"]
    pr_route = api + "/pulls/" + str(t["pr"])
    feature_route = api + "/branches/" + t["branchApi"]
    repo = runtime.api(api)
    pr = runtime.api(pr_route)
    main = runtime.api(api + "/branches/main")
    feature = runtime.api(feature_route)
    head, target = pr.get("head") or {}, pr.get("base") or {}
    validate_upstream_repository_ids(t, repo, head.get("repo"), target.get("repo"))
    require(repo.get("full_name") == t["headRepo"] and repo.get("default_branch") == "main"
            and pr.get("number") == t["pr"] and head.get("sha") == r["mergeHead"]
            and head.get("ref") == t["headRef"] and (head.get("repo") or {}).get("full_name") == t["headRepo"]
            and target.get("ref") == "main" and (target.get("repo") or {}).get("full_name") == t["headRepo"]
            and feature.get("name") == t["headRef"] and (feature.get("commit") or {}).get("sha") == r["mergeHead"]
            and main.get("name") == "main" and main.get("protected") is True, "outcome identity changed")
    if pr.get("state") == "closed" and pr.get("merged_at"):
        merge_sha = pr.get("merge_commit_sha")
        main_sha = (main.get("commit") or {}).get("sha")
        require(type(merge_sha) is str and HEX.fullmatch(merge_sha) and type(main_sha) is str
                and HEX.fullmatch(main_sha), "merged identities unavailable")
        merged = runtime.api(api + "/git/commits/" + merge_sha)
        validate_terminal_lexicon_join(runtime, api, r, t, merged)
        current = runtime.api(api + "/git/commits/" + main_sha)
        require(merged.get("sha") == merge_sha and (merged.get("tree") or {}).get("sha") == r["tree"]
                and current.get("sha") == main_sha and (current.get("tree") or {}).get("sha") == r["tree"],
                "merged tree not proven")
        comparison = runtime.api(api + "/compare/" + merge_sha + "..." + main_sha)
        require(comparison.get("status") in ("ahead", "identical")
                and (comparison.get("base_commit") or {}).get("sha") == merge_sha
                and (comparison.get("merge_base_commit") or {}).get("sha") == merge_sha,
                "merged commit not proven in main")
        require(runtime.api(pr_route) == pr
                and runtime.api(api + "/branches/main") == main
                and runtime.api(feature_route) == feature,
                "terminal observations changed")
        return "MERGED"
    require(pr.get("state") == "open" and pr.get("merged_at") is None, "PR state unknown")
    admission(root, job, base, wt)
    owner, name = t["headRepo"].split("/", 1)
    query = ('query { repository(owner: "' + owner + '", name: "' + name + '") { pullRequest(number: '
             + str(t["pr"]) + ') { number headRefOid mergeQueueEntry { id } } } }')
    data = decode(runtime.command(["/opt/homebrew/bin/gh", "api", "graphql", "-f", "query=" + query]).encode())
    node = ((data.get("data") or {}).get("repository") or {}).get("pullRequest") or {}
    require(not data.get("errors") and node.get("number") == t["pr"] and node.get("headRefOid") == r["mergeHead"]
            and "mergeQueueEntry" in node, "queue status unknown")
    require(runtime.api(pr_route) == pr
            and runtime.api(api + "/branches/main") == main
            and runtime.api(feature_route) == feature,
            "outcome observations changed")
    if node["mergeQueueEntry"] is not None:
        require(type(node["mergeQueueEntry"]) is dict and bool(node["mergeQueueEntry"].get("id")), "queue entry unknown")
        return "QUEUED"
    require("auto_merge" in pr, "auto-merge state unavailable")
    auto = pr["auto_merge"]
    if auto is None:
        return "READY"
    require(type(auto) is dict and auto.get("merge_method") in ("merge", "squash", "rebase")
            and type(auto.get("enabled_by")) is dict
            and type(auto["enabled_by"].get("login")) is str
            and bool(auto["enabled_by"]["login"].strip()), "auto-merge state malformed")
    return "REQUESTED"


def push(root, job, base, wt, token):
    r = verify(root, job, base, wt, upstream=True)
    _, t = upstream_tuple(r)
    directory = Path(root) / "integrated-merge"
    ps = directory.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe launch directory")
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        ds = os.fstat(fd)
        require((ds.st_dev, ds.st_ino) == (ps.st_dev, ps.st_ino), "launch directory changed")
        lock = os.open(t["lockFile"], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        ls = os.fstat(lock)
        require(stat.S_ISREG(ls.st_mode) and ls.st_uid == os.getuid()
                and stat.S_IMODE(ls.st_mode) == 0o600 and ls.st_nlink == 1, "unsafe launch lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempt = journal_read(root, r)
        require(type(token) is str and re.fullmatch(r"[0-9a-f]{64}", token) is not None
                and hashlib.sha256(token.encode()).hexdigest() == attempt["tokenSha256"]
                and attempt["state"] == "ATTEMPTED", "invalid attempt token")
        f = os.open(t["launchFile"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            data = json.dumps(journal_binding(r), sort_keys=True).encode()
            require(os.write(f, data) == len(data), "short launch write")
            os.fsync(f)
        finally:
            os.close(f)
        os.fsync(fd)
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)
    runtime = Runtime(root, wt)
    script = ("set -eu\n. \"$1\"; gs_init; gs_check \"$2\" >/dev/null\n"
              + t["pushLine"] + "\n")
    runtime.command(["/bin/bash", "--noprofile", "--norc", "-c", script, "--", str(runtime.gs), str(wt), r["mergeHead"]])
    return r


# Closed CREATE-only recovery profiles for the two deleted canonical Lexicon
# dependabot refs. Identities, not a routing table; exactly two entries. The
# only write ever issued is one POST repos/ashlrai/lexicon/git/refs with the
# exact JSON keys ref/sha below; never PATCH, delete, force or another ref.
REF_RECOVERY_PROFILES = {
    "lexicon-ref-479": {
        "repo": "ashlrai/lexicon", "repoId": 1376859455, "defaultBranch": "main",
        "pr": 479,
        "headRef": "dependabot/github_actions/actions/download-artifact-8",
        "gitRef": "refs/heads/dependabot/github_actions/actions/download-artifact-8",
        "sha": "3b7c93ff552d3fa7a5b835a416c238c37be78cdd",
        "branchApi": "dependabot%2Fgithub_actions%2Factions%2Fdownload-artifact-8",
        "attemptFile": "lexicon-ref-479.attempt",
        "lockFile": "lexicon-ref-479.outcome-lock",
    },
    "lexicon-ref-480": {
        "repo": "ashlrai/lexicon", "repoId": 1376859455, "defaultBranch": "main",
        "pr": 480,
        "headRef": "dependabot/github_actions/actions/cache-6",
        "gitRef": "refs/heads/dependabot/github_actions/actions/cache-6",
        "sha": "f6975814f2ae2b562c81c57e50c5ecdeb05627d6",
        "branchApi": "dependabot%2Fgithub_actions%2Factions%2Fcache-6",
        "attemptFile": "lexicon-ref-480.attempt",
        "lockFile": "lexicon-ref-480.outcome-lock",
    },
}

RECOVER_STATES = ("ATTEMPTED", "RESTORED", "OBSERVED", "HELD")


def _recover_base_binding(p):
    raw = json.dumps(p, sort_keys=True, separators=(",", ":")).encode()
    return {"schema": 1,
            "profileSha256": hashlib.sha256(raw).hexdigest(),
            "requestSha256": hashlib.sha256(json.dumps(
                {"ref": p["gitRef"], "sha": p["sha"]},
                sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            **{k: p[k] for k in ("repo", "repoId", "defaultBranch", "pr",
                                 "headRef", "gitRef", "sha")}}


RECOVER_BINDING_KEYS = frozenset(
    ("schema", "profileSha256", "requestSha256", "repo", "repoId",
     "defaultBranch", "pr", "headRef", "gitRef", "sha"))


def recover_journal_read(root, p):
    directory = Path(root) / "integrated-merge"
    path = directory / p["attemptFile"]
    value = decode(private_file(path, directory, 4096))
    binding = _recover_base_binding(p)
    require(set(value) == RECOVER_BINDING_KEYS | {"proofSha256", "state", "tokenSha256"}
            and all(value[k] == v for k, v in binding.items())
            and type(value["proofSha256"]) is str
            and re.fullmatch(r"[0-9a-f]{64}", value["proofSha256"]) is not None
            and type(value["tokenSha256"]) is str
            and re.fullmatch(r"[0-9a-f]{64}", value["tokenSha256"]) is not None
            and value["state"] in RECOVER_STATES,
            "attempt custody or binding mismatch")
    return value


def recover_journal_attempt(root, p, proof_sha256):
    directory = Path(root) / "integrated-merge"
    ps = directory.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe attempt directory")
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        require((current.st_dev, current.st_ino) == (ps.st_dev, ps.st_ino), "directory changed")
        try:
            f = os.open(p["attemptFile"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        except FileExistsError:
            recover_journal_read(root, p)
            return "EXISTING"
        try:
            token = secrets.token_hex(32)
            data = json.dumps({**_recover_base_binding(p), "proofSha256": proof_sha256,
                               "state": "ATTEMPTED",
                               "tokenSha256": hashlib.sha256(token.encode()).hexdigest()},
                              sort_keys=True).encode()
            require(os.write(f, data) == len(data), "short journal write")
            os.fsync(f)
        finally:
            os.close(f)
        os.fsync(fd)
        return "CREATED " + token
    finally:
        os.close(fd)


def _recover_record_locked(root, p, status, prior):
    """Replace the attempt record with a terminal state; caller holds lockFile."""
    directory = Path(root) / "integrated-merge"
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = "." + p["attemptFile"] + "." + os.urandom(16).hex()
    try:
        f = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            data = json.dumps({**_recover_base_binding(p), "proofSha256": prior["proofSha256"],
                               "state": status, "tokenSha256": prior["tokenSha256"]},
                              sort_keys=True).encode()
            require(os.write(f, data) == len(data), "short outcome write")
            os.fsync(f)
        finally:
            os.close(f)
        require(recover_journal_read(root, p) == prior, "attempt changed")
        os.replace(name, p["attemptFile"], src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def recover_journal_record(root, p, status):
    require(status in ("RESTORED", "OBSERVED", "HELD"), "bad outcome")
    directory = Path(root) / "integrated-merge"
    ps = directory.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe outcome directory")
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        ds = os.fstat(fd)
        require((ds.st_dev, ds.st_ino) == (ps.st_dev, ps.st_ino), "outcome directory changed")
        lock = os.open(p["lockFile"], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        ls = os.fstat(lock)
        require(stat.S_ISREG(ls.st_mode) and ls.st_uid == os.getuid()
                and stat.S_IMODE(ls.st_mode) == 0o600 and ls.st_nlink == 1, "unsafe outcome lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prior = recover_journal_read(root, p)
        require(prior["state"] == "ATTEMPTED", "attempt already resolved")
        _recover_record_locked(root, p, status, prior)
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def _recover_lock(root, p):
    """Hold the per-tuple outcome lock; returns (dir_fd, lock_fd) or None if busy."""
    directory = Path(root) / "integrated-merge"
    ps = directory.lstat()
    require(stat.S_ISDIR(ps.st_mode) and ps.st_uid == os.getuid()
            and stat.S_IMODE(ps.st_mode) == 0o700, "unsafe attempt directory")
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        ds = os.fstat(fd)
        require((ds.st_dev, ds.st_ino) == (ps.st_dev, ps.st_ino), "directory changed")
        lock = os.open(p["lockFile"], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        ls = os.fstat(lock)
        require(stat.S_ISREG(ls.st_mode) and ls.st_uid == os.getuid()
                and stat.S_IMODE(ls.st_mode) == 0o600 and ls.st_nlink == 1, "unsafe outcome lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        for x in (lock, fd):
            if x is not None:
                os.close(x)
        return None
    except BaseException:
        for x in (lock, fd):
            if x is not None:
                try:
                    os.close(x)
                except OSError:
                    pass
        raise
    return fd, lock


def _recover_ref_state(runtime, p):
    rc, status, body = runtime.api_http(
        "repos/" + p["repo"] + "/git/ref/" + p["gitRef"][len("refs/"):])
    return status, body


def _recover_ref_match(body, p):
    return (type(body) is dict and body.get("ref") == p["gitRef"]
            and type(body.get("object")) is dict
            and body["object"].get("sha") == p["sha"]
            and body["object"].get("type") == "commit")


def _recover_created_exact(body, p):
    return _recover_ref_match(body, p)


def _recover_ref_present(runtime, p):
    try:
        status, body = _recover_ref_state(runtime, p)
    except Refused:
        return False
    return status == 200 and _recover_ref_match(body, p)


def _recover_observe(runtime, p):
    """Fresh read-only classification; raises Refused when unobservable."""
    rc, status, repo = runtime.api_http("repos/" + p["repo"])
    if not (status == 200 and type(repo) is dict and repo.get("id") == p["repoId"]
            and repo.get("full_name") == p["repo"]
            and repo.get("default_branch") == p["defaultBranch"]):
        return "HELD repo-changed"
    rc, status, pr = runtime.api_http("repos/" + p["repo"] + "/pulls/" + str(p["pr"]))
    head = pr.get("head") or {} if type(pr) is dict else {}
    if not (status == 200 and type(pr) is dict and pr.get("number") == p["pr"]
            and pr.get("state") == "closed" and "merged_at" in pr
            and pr["merged_at"] is None and head.get("ref") == p["headRef"]
            and head.get("sha") == p["sha"]
            and (head.get("repo") or {}).get("full_name") == p["repo"]):
        return "HELD pr-changed"
    base = pr.get("base") or {}
    try:
        validate_upstream_repository_ids(p, repo, head.get("repo"), base.get("repo"))
    except Refused:
        return "HELD repository-id-changed"
    status, body = _recover_ref_state(runtime, p)
    if status == 200 and _recover_ref_match(body, p):
        return "OBSERVED"
    if status == 200:
        return "HELD ref-conflict"
    if status == 404:
        return "HELD attempt-unconfirmed"
    return "HELD outcome-unknown"


def recover_preflight(runtime, p):
    """Fresh read-only proof for one closed recovery tuple.

    Every condition must hold on this single pass; unknown, denied,
    paginated, non-literal or mismatched metadata refuses the attempt.
    Returns the observed facts bound into the attempt journal.
    """
    api = "repos/" + p["repo"]
    rc, status, repo = runtime.api_http(api)
    require(status == 200 and type(repo) is dict, "repository unavailable")
    require(repo.get("id") == p["repoId"] and repo.get("full_name") == p["repo"]
            and repo.get("default_branch") == p["defaultBranch"]
            and repo.get("archived") is False and repo.get("disabled") is False,
            "repository identity changed")
    rc, status, pr = runtime.api_http(api + "/pulls/" + str(p["pr"]))
    require(status == 200 and type(pr) is dict, "original PR unavailable")
    head, base = pr.get("head") or {}, pr.get("base") or {}
    validate_upstream_repository_ids(p, repo, head.get("repo"), base.get("repo"))
    require(pr.get("number") == p["pr"] and pr.get("state") == "closed"
            and "merged_at" in pr and pr["merged_at"] is None
            and head.get("ref") == p["headRef"] and head.get("sha") == p["sha"]
            and (head.get("repo") or {}).get("full_name") == p["repo"]
            and base.get("ref") == p["defaultBranch"]
            and (base.get("repo") or {}).get("full_name") == p["repo"],
            "original PR tuple changed")
    rc, status, commit = runtime.api_http(api + "/git/commits/" + p["sha"])
    require(status == 200 and type(commit) is dict and commit.get("sha") == p["sha"]
            and type(commit.get("tree")) is dict and type(commit.get("parents")) is list,
            "original commit unavailable")
    # Exact absence, proven against the independent repository read above.
    status, _ = _recover_ref_state(runtime, p)
    require(status == 404, "exact ref is not absent")
    # Classic protection inventory must be complete and only literal main.
    owner, name = p["repo"].split("/", 1)
    query = ('query { repository(owner: "' + owner + '", name: "' + name + '") { defaultBranchRef { name } '
             'branchProtectionRules(first: 100) { nodes { pattern } pageInfo { hasNextPage } } } }')
    data = decode(runtime.command(["/opt/homebrew/bin/gh", "api", "graphql", "-f", "query=" + query]).encode())
    node = (data.get("data") or {}).get("repository") or {}
    rules = node.get("branchProtectionRules") or {}
    patterns = rules.get("nodes")
    page = rules.get("pageInfo") or {}
    require(not data.get("errors")
            and (node.get("defaultBranchRef") or {}).get("name") == p["defaultBranch"]
            and type(patterns) is list and len(patterns) == 1
            and type(patterns[0]) is dict and patterns[0].get("pattern") == p["defaultBranch"]
            and page.get("hasNextPage") is False,
            "classic protection inventory unknown")
    rc, status, rulesets = runtime.api_http(api + "/rulesets")
    require(status == 200 and type(rulesets) is list
            and all(type(item) is dict and type(item.get("id")) is int for item in rulesets),
            "ruleset inventory unknown")
    rc, status, branch_rules = runtime.api_http(api + "/rules/branches/" + p["branchApi"])
    require(status == 200 and type(branch_rules) is list and branch_rules == [],
            "branch rule read unknown or non-empty")
    return {"repoId": repo["id"], "defaultBranch": repo["default_branch"],
            "pr": pr["number"], "prState": pr["state"], "mergedAt": pr["merged_at"],
            "headRef": head["ref"], "headSha": head["sha"],
            "commitSha": commit["sha"], "refStatus": 404,
            "classicPatterns": [item["pattern"] for item in patterns],
            "rulesetCount": len(rulesets), "branchRules": branch_rules}


def _recover_suffix(p):
    return " " + p["gitRef"] + " " + p["sha"]


def _recover_report(root, p, runtime):
    """Read-only reconcile for an existing attempt journal; never writes."""
    prior = recover_journal_read(root, p)
    try:
        result = _recover_observe(runtime, p)
    except Refused:
        return "HELD reconcile-unavailable" + _recover_suffix(p)
    if prior["state"] == "ATTEMPTED":
        try:
            recover_journal_record(root, p, "OBSERVED" if result == "OBSERVED" else "HELD")
        except (BlockingIOError, Refused, OSError):
            pass
    return result + _recover_suffix(p)


def recover_ref(root, name):
    """Run one closed CREATE-only ref recovery; returns the outcome line."""
    p = REF_RECOVERY_PROFILES.get(name)
    require(p is not None and type(name) is str, "unknown ref recovery profile")
    directory = Path(root) / "integrated-merge"
    attempt_path = directory / p["attemptFile"]
    runtime = Runtime(root)
    if attempt_path.exists() or attempt_path.is_symlink():
        return _recover_report(root, p, runtime)
    proof = recover_preflight(runtime, p)
    proof_sha = hashlib.sha256(json.dumps(proof, sort_keys=True,
                        separators=(",", ":")).encode()).hexdigest()
    attempt = recover_journal_attempt(root, p, proof_sha)
    if attempt == "EXISTING":
        return _recover_report(root, p, runtime)
    token = attempt.split(" ", 1)[1]
    held = _recover_lock(root, p)
    if held is None:
        return _recover_report(root, p, runtime)
    ds_fd, lock_fd = held
    try:
        # Immediately before the single bounded write, re-prove everything.
        recover_preflight(runtime, p)
        prior = recover_journal_read(root, p)
        require(prior["state"] == "ATTEMPTED"
                and hashlib.sha256(token.encode()).hexdigest() == prior["tokenSha256"],
                "attempt custody changed")
        try:
            rc, status, body = runtime.api_http(
                "repos/" + p["repo"] + "/git/refs",
                fields=(("ref", p["gitRef"]), ("sha", p["sha"])))
        except Refused:
            status, body = None, None
        if status == 201 and _recover_created_exact(body, p) and _recover_ref_present(runtime, p):
            _recover_record_locked(root, p, "RESTORED", prior)
            return "RESTORED" + _recover_suffix(p)
        try:
            result = _recover_observe(runtime, p)
        except Refused:
            return "HELD reconcile-unavailable" + _recover_suffix(p)
        _recover_record_locked(root, p, "OBSERVED" if result == "OBSERVED" else "HELD", prior)
        return result + _recover_suffix(p)
    finally:
        os.close(lock_fd)
        os.close(ds_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job")
    parser.add_argument("--base")
    parser.add_argument("--worktree")
    parser.add_argument("--upstream-original157", action="store_true")
    parser.add_argument("--upstream-feature", action="store_true")
    parser.add_argument("--post-push", action="store_true")
    parser.add_argument("--admission", action="store_true")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--attempt", action="store_true")
    parser.add_argument("--push", action="store_true")
    parser.add_argument("--outcome", action="store_true")
    parser.add_argument("--record-outcome", choices=("HELD", "REQUESTED", "QUEUED", "MERGED"))
    parser.add_argument("--token")
    parser.add_argument("--recover-lexicon-ref", action="store_true")
    parser.add_argument("--ref-profile")
    args = parser.parse_args()
    try:
        upstream = args.upstream_original157 or args.upstream_feature
        root = Path.home() / ".ashlr-runs"
        if args.recover_lexicon_ref:
            require(args.ref_profile is not None and type(args.ref_profile) is str,
                    "ref recovery profile required")
            require(not any((args.job, args.base, args.worktree, args.prepare, args.attempt,
                             args.push, args.outcome, args.record_outcome, args.post_push,
                             args.admission, upstream, args.token)),
                    "recovery accepts only --ref-profile")
            print(recover_ref(root, args.ref_profile))
            return 0
        require(args.ref_profile is None, "ref-profile requires recovery mode")
        require(args.job is not None and args.base is not None and args.worktree is not None,
                "job base and worktree required")
        require(not (args.post_push or args.admission) or upstream,
                "post-push requires profile")
        require(not (args.post_push and args.admission), "choose one verification phase")
        flags = (args.prepare, args.attempt, args.push, args.outcome, bool(args.record_outcome), args.post_push, args.admission)
        require(sum(map(bool, flags)) <= 1, "choose one phase")
        require(not any(flags) or upstream, "profile required")
        if args.prepare:
            r = prepare(root, args.job, args.base, args.worktree)
        elif args.attempt:
            r = prepare(root, args.job, args.base, args.worktree)
            print(journal_attempt(root, r))
            return 0
        elif args.push:
            r = push(root, args.job, args.base, args.worktree, args.token)
        elif args.outcome:
            print(outcome(root, args.job, args.base, args.worktree))
            return 0
        elif args.record_outcome:
            r = prepare(root, args.job, args.base, args.worktree)
            if args.record_outcome != "HELD":
                require(outcome(root, args.job, args.base, args.worktree) == args.record_outcome, "outcome not observed")
            record_outcome(root, r, args.record_outcome)
            print(args.record_outcome)
            return 0
        elif args.admission:
            r = admission(root, args.job, args.base, args.worktree)
        else:
            r = verify(root, args.job, args.base, args.worktree,
                       upstream, args.post_push)
        print(" ".join((str(r["pr"]), r["mainHead"], r["originalHead"],
                        r["mergeHead"], r["tree"])))
    except (Refused, OSError, ValueError, KeyError, IndexError, TypeError, AttributeError,
            subprocess.SubprocessError):
        # Private reconciliation text and remote responses never enter run logs.
        print("integrated merge proof refused", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
