"""Shared Mac queue admission and read-only CLI. Standard library only."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

TIERS = {"frontier", "work", "mid", "fast"}
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
REPOS = {"phantom", "phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-plugin", "ashlr-stack"}


def read(path):
    try:
        return Path(path).read_text()
    except FileNotFoundError:
        return ""


def gh(args):
    try:
        result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=15)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def dependency_ids(text):
    ids = []
    for match in re.finditer(r"(?im)^\s*DEPENDENCY GATE:\s*([^\n]+?)\s+MERGED\s*$", text):
        tokens = re.split(r"[,\s]+", match.group(1).strip())
        if not tokens or any(not TOKEN.fullmatch(token) for token in tokens):
            raise ValueError("invalid dependency gate")
        ids.extend(tokens)
    # A malformed gate must never become an empty (satisfied) dependency list.
    if len(re.findall(r"(?im)^\s*DEPENDENCY GATE:", text)) != len(list(re.finditer(
            r"(?im)^\s*DEPENDENCY GATE:\s*[^\n]+?\s+MERGED\s*$", text))):
        raise ValueError("invalid dependency gate")
    return list(dict.fromkeys(ids))


def merged(repo, dep):
    # Search title evidence and branch evidence separately: title search alone
    # cannot find a bridge PR whose title omitted its dependency ID.
    for search in (f"{dep} in:title", f"head:codex-bridge/{dep}"):
        rows = gh(["pr", "list", "--repo", f"ashlrai/{repo}", "--state", "merged",
                   "--search", search, "--limit", "100", "--json", "number,headRefName,title,mergedAt"])
        if isinstance(rows, list) and any(isinstance(row, dict) and row.get("mergedAt") and (
                row.get("headRefName") == f"codex-bridge/{dep}" or dep in row.get("title", "")) for row in rows):
            return True
    return False


def adaptive_cap(depth, available):
    # One open bridge PR per idle online runner, minus queued merge work.
    # Two always remain admissible to prevent a saturated queue from starving
    # its own recovery. Missing/private runner evidence uses this floor.
    return max(2, available - depth)


def capacity(repo):
    prs = gh(["pr", "list", "--repo", f"ashlrai/{repo}", "--state", "open", "--limit", "1000",
              "--json", "headRefName"])
    runners = gh(["api", f"repos/ashlrai/{repo}/actions/runners?per_page=100"])
    queue = gh(["api", "graphql", "-f", "query=query { repository(owner: \"ashlrai\", name: \"" + repo +
                "\") { mergeQueue { entries { totalCount } } } }"])
    try:
        merge_queue = queue["data"]["repository"]["mergeQueue"]
        depth = merge_queue["entries"]["totalCount"] if merge_queue is not None else 0
        available = sum(r.get("status") == "online" and r.get("busy") is False for r in runners["runners"])
        if runners.get("total_count", 0) > len(runners["runners"]):
            available = 0  # incomplete evidence cannot increase admission
        cap = adaptive_cap(depth, available)
    except (KeyError, TypeError):
        cap = 2
    opened = sum(p.get("headRefName", "").startswith("codex-bridge/") for p in prs) if isinstance(prs, list) else None
    if isinstance(prs, list) and len(prs) >= 1000:
        opened = None  # truncated inventory fails closed
    return {"cap": cap, "open": opened}


def inspect(queue):
    rows = []
    evidence = {}
    for index, line in enumerate(read(queue / "parked.tsv").splitlines()):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split("\t")
        row = {"index": index, "id": fields[0], "dependencies": [], "eligible": False}
        rows.append(row)
        if len(fields) not in (5, 6) or (len(fields) == 6 and fields[5] != "pin=1"):
            row["error"] = "invalid fields"
            continue
        job, repo, lane, tier, prompt = fields[:5]
        row.update(repo=repo, lane=lane, tier=tier)
        if not TOKEN.fullmatch(job) or repo not in REPOS or not TOKEN.fullmatch(lane):
            row["error"] = "invalid identity"
            continue
        if tier not in TIERS:
            row["error"] = "invalid tier"
            continue
        try:
            # Missing/unreadable prompts are not evidence of an empty gate.
            path = Path(prompt) if Path(prompt).is_absolute() else queue / prompt
            ids = dependency_ids(path.read_text())
        except (OSError, ValueError):
            row["error"] = "unreadable prompt or invalid gate"
            continue
        for dep in ids:
            key = (repo, dep)
            if key not in evidence:
                evidence[key] = merged(repo, dep)
            row["dependencies"].append({"id": dep, "merged": evidence[key]})
        row["eligible"] = all(d["merged"] for d in row["dependencies"])
    return rows


def plan(queue, rows=None, capacities=None):
    rows = inspect(queue) if rows is None else rows
    capacities = {} if capacities is None else capacities
    initialized = set()
    ready = read(queue / "ready.tsv").splitlines()
    ids = {line.split("\t")[0] for line in ready}
    for row in rows:
        row["promote"] = False
        if not row["eligible"] or row["id"] in ids:
            continue
        repo = row["repo"]
        if repo not in initialized:
            initialized.add(repo)
            if repo not in capacities:
                capacities[repo] = capacity(repo)
            capacities[repo]["ready"] = sum(len(f) >= 5 and f[1] == repo for f in (line.split("\t") for line in ready))
        cap = capacities[repo]
        if cap["open"] is not None and cap["open"] + cap["ready"] < cap["cap"]:
            row["promote"] = True
            cap["ready"] += 1
            ids.add(row["id"])
    return {"parked": rows, "promote": [row["id"] for row in rows if row["promote"]], "capacity": capacities}


def promote(queue):
    queue = Path(queue)
    queue.mkdir(parents=True, exist_ok=True)
    # Network evidence is collected outside the short queue mutation lock.
    parked_snapshot = read(queue / "parked.tsv")
    result = plan(queue)
    with (queue / "ready.lock").open("a") as lock:
        deadline = time.monotonic() + float(os.environ.get("ASHLR_READY_LOCK_TIMEOUT", "10"))
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("ready.lock busy; nothing promoted")
                time.sleep(0.05)
        if read(queue / "parked.tsv") != parked_snapshot:
            # Another writer changed the parked inventory. Retry next pass.
            return {"parked": [], "promote": [], "capacity": {}, "retry": True}
        result = plan(queue, result["parked"], result["capacity"])
        stamp = datetime.datetime.now().astimezone()
        chosen = {row["index"] for row in result["parked"] if row["promote"]}
        if chosen:
            ready = queue / "ready.tsv"
            backup = queue / ("ready.tsv.bak-autounpark-" + stamp.strftime("%Y%m%d-%H%M%S"))
            # Exclusive creation preserves an earlier backup in the same second.
            with backup.open("x") as target:
                target.write(read(ready))
            parked = read(queue / "parked.tsv").splitlines(keepends=True)
            additions = [line.rstrip("\n") for index, line in enumerate(parked) if index in chosen]
            text = read(ready)
            tmp = queue / "ready.tsv.autounpark.tmp"
            tmp.write_text(text + ("\n" if text and not text.endswith("\n") else "") + "\n".join(additions) + "\n")
            os.replace(tmp, ready)
            tmp = queue / "parked.tsv.autounpark.tmp"
            tmp.write_text("".join(line for index, line in enumerate(parked) if index not in chosen))
            os.replace(tmp, queue / "parked.tsv")
        with (queue / "unpark.log").open("a") as log:
            for row in result["parked"]:
                if row.get("error"):
                    log.write(f'{stamp.isoformat()} REJECT {row["id"]} {row["error"]}\n')
                elif row["promote"]:
                    deps = ",".join(d["id"] for d in row["dependencies"])
                    log.write(f'{stamp.isoformat()} UNPARK {row["id"]} deps={deps}\n')
        return result


if __name__ == "__main__":
    root = Path.home() / ".ashlr-runs" / "queue"
    if sys.argv[1:] == ["parked"]:
        print(json.dumps({"parked": inspect(root)}))
    elif sys.argv[1:] == ["dry-run"]:
        print(json.dumps(plan(root)))
    else:
        sys.exit("usage: queue_autounpark.py parked|dry-run")
