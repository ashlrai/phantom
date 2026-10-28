#!/usr/bin/env python3
"""Disk lifecycle for trusted Mac bridge worktrees, without provider access."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

FLOOR = 20 * 1024**3
CAP = 8 * 1024**3
HELPER = Path(__file__).resolve().parents[1] / "bridge-worktree.mjs"


class Refused(Exception):
    """Only constant, value-blind reason codes may cross this boundary."""


def git(path, *args):
    try:
        result = subprocess.run(["git", "-C", str(path), *args],
                                capture_output=True, timeout=60, check=False)
    except subprocess.TimeoutExpired:
        raise Refused("git-timeout") from None
    if result.returncode:
        raise Refused("git-failed")
    return result.stdout


def directory(path):
    path = Path(os.path.abspath(path))
    # Canonical callers avoid /tmp and /var aliases on macOS. Never accept
    # links introduced underneath the bridge's private state directory.
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise Refused("symlinked-directory")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise Refused("unsafe-state-directory")
    return path


def key(path):
    return hashlib.sha256(os.fsencode(path)).hexdigest()[:32]


def validate_job(job):
    if not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", job):
        raise Refused("invalid-job")


def open_private(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise Refused("unsafe-state-file")
    return fd


@contextmanager
def lock(path, shared=False):
    fd = open_private(path, os.O_CREAT | os.O_RDWR)
    try:
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("active-lease") from None
        yield fd
    finally:
        os.close(fd)


def du(path):
    """Allocated bytes reported by du; APFS shared extents are counted again."""
    try:
        path.lstat()
    except FileNotFoundError:
        return 0
    except OSError:
        return None
    try:
        result = subprocess.run(["/usr/bin/du", "-sk", str(path)],
                                capture_output=True, timeout=60, check=False)
        if result.returncode:
            return None
        return int(result.stdout.split(maxsplit=1)[0]) * 1024
    except (subprocess.TimeoutExpired, ValueError, IndexError):
        return None


def snapshot(worktree, cache, state):
    # A missing/failed measurement is unknown, never zero. df/statvfs is the
    # volume measurement; du is attribution, not exclusive APFS allocation.
    usage = shutil.disk_usage(worktree if worktree.exists() else worktree.parent)
    paths = {"worktree": worktree, "node_modules": worktree / "node_modules",
             "target": worktree / "target", "desktop_target": worktree / "desktop/src-tauri/target",
             "shared_target": cache, "quarantine": state / "quarantine"}
    return {"free_bytes": usage.free, "used_bytes": usage.used,
            "du_bytes": {label: du(path) for label, path in paths.items()}}


def log(state, job, event, worktree, cache, **fields):
    record = {"schema": 1, "time": time.time(), "job": job, "event": event,
              "repo_key": cache.parent.name, **snapshot(worktree, cache, state), **fields}
    fd = open_private(state / "disk.log", os.O_CREAT | os.O_WRONLY | os.O_APPEND)
    with os.fdopen(fd, "a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(record, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return record


def identity(worktree):
    worktree = Path(os.path.abspath(worktree))
    if worktree.resolve(strict=True) != worktree:
        raise Refused("symlinked-worktree")
    top = Path(os.fsdecode(git(worktree, "rev-parse", "--show-toplevel")).strip())
    common = Path(os.fsdecode(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()).resolve()
    gitdir = Path(os.fsdecode(git(worktree, "rev-parse", "--absolute-git-dir")).strip()).resolve()
    if top != worktree or common == gitdir or (gitdir / "locked").exists():
        raise Refused("not-unlocked-linked-worktree")
    return worktree, common


def layout(state, common):
    state = directory(state)
    for name in ("repos", "runs", "locks", "quarantine"):
        directory(state / name)
    repo = directory(state / "repos" / key(common))
    return state, repo / "target"


def check_budget(worktree, cache, cap):
    if shutil.disk_usage(worktree).free < FLOOR:
        raise Refused("disk-below-20-gib")
    size = du(cache)
    if size is None:
        raise Refused("target-size-unknown")
    if size > cap:
        raise Refused("target-cap-exceeded")


def clean_cache(cache):
    if cache.is_symlink():
        raise Refused("symlinked-target")
    if cache.exists():
        shutil.rmtree(cache)
    directory(cache)


def atomic_json(path, record):
    stage = path.with_name(path.name + "." + uuid.uuid4().hex)
    fd = open_private(stage, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stage, path)
    finally:
        stage.unlink(missing_ok=True)


def stop_group(child):
    # Descendants inherit the command's group. Kill only this owned group,
    # including children left after a successful leader exit.
    for sig, delay in ((signal.SIGTERM, 0.2), (signal.SIGKILL, 0)):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            break
        except PermissionError:
            # Darwin can report EPERM for a zombie-only process group. The
            # unreaped leader still reserves its PID; only accept this result
            # after the kernel confirms that our exact child has exited.
            if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                raise
            break
        if delay:
            time.sleep(delay)
    child.wait()


def supervised(command, cwd, env, cache, cap, interval=1, lease_fds=()):
    child = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True, pass_fds=lease_fds)
    stopped = False
    try:
        while True:
            # WNOWAIT retains the leader's PID until its owned group is stopped;
            # poll()/wait() here would permit PID reuse before killpg in finally.
            status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if status is not None:
                code = status.si_status if status.si_code == os.CLD_EXITED else 128 + status.si_status
                stop_group(child)
                stopped = True
                break
            check_budget(cwd, cache, cap)
            time.sleep(interval)
        check_budget(cwd, cache, cap)
        return code
    finally:
        if not stopped:
            stop_group(child)


def launch(source, worktree, state, job, command, cap=CAP):
    validate_job(job)
    if not command:
        raise Refused("command-required")
    worktree, common = identity(worktree)
    state, cache = layout(state, common)
    receipt_path = state / "runs" / (key(worktree) + ".json")
    log(state, job, "launch-before", worktree, cache)
    try:
        with lock(state / "locks" / key(worktree)) as worktree_lease:
            if receipt_path.exists():
                raise Refused("run-already-prepared")
            # New launches can overlap. Only cache eviction takes an exclusive
            # repo lease, so no publish/reaper can delete an active Cargo target.
            size = du(cache)
            if size is None:
                raise Refused("target-size-unknown")
            if size > cap:
                with lock(cache.parent / "lease"):
                    clean_cache(cache)
            with lock(cache.parent / "lease", shared=True) as cargo_lease:
                directory(cache)
                check_budget(worktree, cache, cap)
                source = Path(source).resolve(strict=True)
                source_common = Path(os.fsdecode(git(source, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()).resolve()
                if source_common != common:
                    raise Refused("dependency-source-repository-mismatch")
                prepared = False
                if (worktree / "package.json").exists():
                    result = subprocess.run(["node", str(HELPER), "--require-clone", str(source), str(worktree)],
                                            capture_output=True, timeout=30, check=False)
                    if result.returncode:
                        raise Refused("dependency-clone-failed")
                    prepared = True
                modules = (worktree / "node_modules").lstat() if prepared else None
                record = {"schema": 1, "job": job, "worktree": str(worktree), "common": str(common),
                          "modules_identity": [modules.st_dev, modules.st_ino] if modules else None,
                          "created_at": time.time()}
                atomic_json(receipt_path, record)
                env = os.environ.copy()
                env["CARGO_TARGET_DIR"] = str(cache)
                # Cargo's newer separate intermediate-output override could
                # otherwise bypass this managed target and its measurements.
                env.pop("CARGO_BUILD_BUILD_DIR", None)
                code = supervised(command, worktree, env, cache, cap,
                                  lease_fds=(worktree_lease, cargo_lease))
                log(state, job, "launch-finished", worktree, cache, exit_code=code)
                return code
    except (Refused, OSError, subprocess.TimeoutExpired) as error:
        log(state, job, "launch-refused", worktree, cache,
            reason=str(error) if isinstance(error, Refused) else "operation-failed")
        raise


def verify_clean(worktree, head):
    if git(worktree, "rev-parse", "HEAD").decode().strip() != head:
        raise Refused("publication-head-mismatch")
    if git(worktree, "status", "--porcelain=v1", "-z", "--untracked-files=no"):
        raise Refused("tracked-changes")
    for record in git(worktree, "ls-files", "-v", "-z").split(b"\0"):
        if record and (record[:1].islower() or record[:1] == b"S"):
            raise Refused("hidden-index-entry")
    if any(record.startswith(b"160000 ") for record in git(worktree, "ls-files", "--stage", "-z").split(b"\0")):
        raise Refused("submodule-worktree")


def publication(worktree, evidence):
    if not isinstance(evidence, dict):
        raise Refused("publication-evidence-required")
    url, head, observed = (evidence.get(name) for name in ("url", "head_oid", "observed_at"))
    if not isinstance(url, str) or not re.fullmatch(r"https://github\.com/ashlrai/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*", url):
        raise Refused("publication-url-invalid")
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40,64}", head):
        raise Refused("publication-head-invalid")
    now = time.time()
    if not isinstance(observed, (int, float)) or not now - 300 <= observed <= now:
        raise Refused("publication-evidence-stale")
    repo = url.split("/pull/")[0].removeprefix("https://github.com/")
    remote = os.fsdecode(git(worktree, "remote", "get-url", "origin")).strip().removesuffix(".git")
    if remote not in ("https://github.com/" + repo, "git@github.com:" + repo):
        raise Refused("publication-repository-mismatch")
    verify_clean(worktree, head)
    return head


def remove_modules(worktree, receipt):
    modules = worktree / "node_modules"
    expected = receipt.get("modules_identity")
    if expected is None or not modules.exists():
        return
    info = modules.lstat()
    if not stat.S_ISDIR(info.st_mode) or [info.st_dev, info.st_ino] != expected:
        raise Refused("prepared-dependencies-replaced")
    if git(worktree, "ls-files", "-z", "--", "node_modules"):
        raise Refused("tracked-dependencies")
    # Only this run's freshly cloned dependency tree is regenerable. Arbitrary
    # old node_modules/target trees go to quarantine with all other user files.
    shutil.rmtree(modules)


def quarantine(worktree, state, job):
    entries = git(worktree, "ls-files", "--others", "--directory", "--no-empty-directory", "-z")
    destination = directory(state / "quarantine" / (job + "-" + uuid.uuid4().hex))
    moves = []
    for raw in entries.split(b"\0"):
        if not raw:
            continue
        relative = Path(os.fsdecode(raw).rstrip("/"))
        if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
            raise Refused("unsafe-untracked-path")
        source = worktree / relative
        if source.parent.resolve() != source.parent:
            raise Refused("symlinked-untracked-parent")
        target = destination / relative
        directory(target.parent)
        if source.lstat().st_dev != target.parent.stat().st_dev:
            raise Refused("cross-volume-quarantine")
        moves.append((source, target))
    for source, target in moves:
        os.rename(source, target)
    return len(moves)


def finish(worktree, state, job, evidence):
    validate_job(job)
    worktree, common = identity(worktree)
    state, cache = layout(state, common)
    log(state, job, "publish-before", worktree, cache)
    removed = False
    try:
        with lock(state / "locks" / key(worktree)):
            current = Path.cwd().resolve()
            if current == worktree or worktree in current.parents:
                raise Refused("current-worktree")
            receipt_path = state / "runs" / (key(worktree) + ".json")
            fd = open_private(receipt_path, os.O_RDONLY)
            with os.fdopen(fd) as stream:
                receipt = json.load(stream)
            if receipt.get("schema") != 1 or receipt.get("job") != job or receipt.get("worktree") != str(worktree) or receipt.get("common") != str(common):
                raise Refused("run-receipt-mismatch")
            head = publication(worktree, evidence)
            remove_modules(worktree, receipt)
            moved = quarantine(worktree, state, job)
            verify_clean(worktree, head)
            if git(worktree, "ls-files", "--others", "--directory", "--no-empty-directory", "-z"):
                raise Refused("untracked-files-changed")
            git(common, "worktree", "remove", str(worktree))
            removed = True
            receipt_path.unlink()
            prune = "ok"
            try:
                git(common, "worktree", "prune")
            except Refused:
                prune = "failed"
            # Mark deferred cleanup durably: an idle reaper can retry after
            # other worktrees release their shared Cargo lease.
            try:
                atomic_json(cache.parent / "cleanup-pending.json", {"job": job, "worktree": str(worktree)})
                target = trim(cache)
            except (Refused, OSError):
                target = "failed"
            return log(state, job, "publish-removed", worktree, cache,
                       quarantined_entries=moved, prune=prune, target_cleanup=target)
    except (Refused, OSError, ValueError) as error:
        log(state, job, "publish-cleanup-failed" if removed else "publish-retained", worktree, cache,
            reason=str(error) if isinstance(error, Refused) else "operation-failed")
        raise


def trim(cache):
    try:
        with lock(cache.parent / "lease"):
            clean_cache(cache)
            (cache.parent / "cleanup-pending.json").unlink(missing_ok=True)
        return "removed"
    except Refused as error:
        if str(error) == "active-lease":
            return "deferred-active-lease"
        raise


def reap_pending(state, worktree, job):
    """Idle-cycle retry for targets kept alive by another worktree at publish."""
    validate_job(job)
    state = directory(state)
    repos = directory(state / "repos")
    for repo in sorted(repos.glob("*")):
        if not re.fullmatch(r"[0-9a-f]{32}", repo.name) or repo.is_symlink():
            raise Refused("unsafe-repository-cache")
        directory(repo)
        if (repo / "cleanup-pending.json").exists():
            outcome = trim(repo / "target")
            log(state, job, "reap-target", worktree, repo / "target", target_cleanup=outcome)


def attribute_repository(worktree, state, job):
    validate_job(job)
    worktree, common = identity(worktree)
    state, cache = layout(state, common)
    rows = []
    for field in git(common, "worktree", "list", "--porcelain", "-z").split(b"\0"):
        if not field.startswith(b"worktree "):
            continue
        path = Path(os.fsdecode(field[len(b"worktree "):]))
        rows.append({"worktree": str(path), "du_bytes": {
            "total": du(path), "node_modules": du(path / "node_modules"),
            "target": du(path / "target"), "desktop_target": du(path / "desktop/src-tauri/target")}})
    return log(state, job, "repository-attribution", worktree, cache, worktrees=rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("launch", "publish", "reap", "measure", "attribute"))
    parser.add_argument("--worktree", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".ashlr-runs")
    parser.add_argument("--job", required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--publication", type=Path, help="Fresh Locus-observed PR metadata JSON")
    parser.add_argument("--target-cap-bytes", type=int, default=CAP)
    argv = sys.argv[1:]
    split = argv.index("--") if "--" in argv else len(argv)
    args = parser.parse_args(argv[:split])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.job) or not 1 <= args.target_cap_bytes <= CAP:
        parser.error("invalid job or target cap (maximum 8 GiB)")
    command = argv[split + 1:]
    try:
        if args.action == "launch":
            if args.source is None:
                raise Refused("source-required")
            return launch(args.source, args.worktree, args.state_dir, args.job, command, args.target_cap_bytes)
        if command:
            raise Refused("command-only-valid-for-launch")
        if args.action == "reap" and args.publication is None:
            reap_pending(args.state_dir, args.worktree, args.job)
            return 0
        if args.action == "attribute":
            attribute_repository(args.worktree, args.state_dir, args.job)
            return 0
        if args.action == "measure":
            worktree, common = identity(args.worktree)
            state, cache = layout(args.state_dir, common)
            log(state, args.job, "measurement", worktree, cache)
        else:
            if args.publication is None:
                raise Refused("publication-required")
            finish(args.worktree, args.state_dir, args.job, json.loads(args.publication.read_text()))
        return 0
    except (Refused, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print("Bridge disk lifecycle refused: " + (str(error) if isinstance(error, Refused) else "operation-failed"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
