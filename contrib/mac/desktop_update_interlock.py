"""Local-only desktop update admission and bounded dispatcher census."""
# phantom.desktop-update-interlock.v1
import fcntl
import os
from pathlib import Path
import re
import stat
import subprocess

CAPABILITY = "phantom.desktop-update-interlock.v1"
JOB = r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}"


def held(home):
    try:
        os.lstat(Path(home) / ".ashlr" / "DESKTOP_UPDATE_STOP")
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def tick_claim(queue, create=True):
    flags = os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW
    if create:
        flags |= os.O_CREAT
    fd = os.open(Path(queue) / "dispatchd.tick.lock", flags, 0o600)
    try:
        proof = os.fstat(fd)
        if not stat.S_ISREG(proof.st_mode) or proof.st_uid != os.getuid() or proof.st_nlink != 1 or proof.st_mode & 0o022:
            raise OSError("unsafe dispatcher lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def census(home, queue, capture):
    """Use the same lock as launch admission; unidentified work cannot report idle."""
    result = dict(schema=CAPABILITY, activeJobs=0, unknown=1)
    try:
        # Do not create any file on the read-only census path.
        fd = tick_claim(queue, create=False)
    except OSError:
        return result
    try:
        root = Path(queue).parent
        runs = Path(queue) / "run"
        for directory in (Path(queue), runs):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                return result
        jobs = set()
        snapshot = capture(timeout=2)
        if snapshot.returncode or not snapshot.stdout.strip():
            return result
        worker_roots = (str(root), str(Path(home) / "Projects" / "ashlrai" / "wt"))
        process_job = re.compile(r"(?:/wt/|(?:[ /])(?:launch|batch-launch|publish|reap-one)\.sh |[ /]local_job\.py |"
                                 + re.escape(str(root)) + r"/)(" + JOB + r")(?:\.prompt\b|[ /]|$)")
        for row in snapshot.stdout.splitlines():
            if "dispatchd.py" in row or "dispatchd.candidate.py" in row:
                continue
            match = process_job.search(row)
            if match:
                jobs.add(match.group(1))
            elif any(root_path + "/" in row for root_path in worker_roots):
                return result
        if any(root.glob("*.base")):
            cwd = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-u", str(os.getuid()), "-d", "cwd", "-Fn"],
                                 stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=2)
            if cwd.returncode or not cwd.stdout.strip():
                return result
            prefix = "n" + worker_roots[1] + "/"
            for row in cwd.stdout.splitlines():
                if row.startswith(prefix):
                    job = row[len(prefix):].split("/", 1)[0]
                    if not re.fullmatch(JOB, job):
                        return result
                    jobs.add(job)
        for path in runs.iterdir():
            if path.suffix in (".dispatched", ".reaping"):
                info = path.lstat()
                valid_type = stat.S_ISDIR(info.st_mode) if path.suffix == ".reaping" else stat.S_ISREG(info.st_mode)
                if not re.fullmatch(JOB, path.stem) or not valid_type or info.st_uid != os.getuid():
                    return result
                jobs.add(path.stem)
        for lock in (root / "release-sign" / "lock", root / "release-sign" / "autorun" / "lock"):
            try:
                lock.lstat()
            except FileNotFoundError:
                continue
            jobs.add("release-helper")
        return dict(schema=CAPABILITY, activeJobs=len(jobs), unknown=0)
    except (OSError, ValueError, subprocess.SubprocessError):
        return result
    finally:
        os.close(fd)
