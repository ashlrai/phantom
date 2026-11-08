#!/usr/bin/python3
"""Rebase batch ordering (RQ-SWE3-REBASEORDER-1).

Convention: RQ-REBASE-* jobs that touch the same file belong to one cluster and
must land in the SAME batch session, because a sibling PR merging mid-flight
re-dirties every other PR sharing its files — one batch resolves the cluster in
order instead of each session invalidating the next. Jobs whose file sets are
disjoint spread across batches: a cluster never absorbs unrelated work and
unrelated areas never absorb a cluster.

A job's file set comes from its queue line: the `cluster=clu-<n>` key queuegen
stamps over the PR's full touched-file list (src/core/fleet/rebase-order.ts)
counts as one shared edge that can only merge clusters; the `conflicts="…"`
paths plus the `file=` field are the fallback. Clustering is over shared files
transitively — A∩B and B∩C put A,B,C in one cluster. Truncation can only
under-cluster (a sibling missed in the cut-off tail), never wrongly merge.

The cluster key is `rebase:clu-<lowest PR number>`; dispatchd assigns it as the
batching area (`assign_areas`) so batcher.py's same-area grouping lands the
cluster in one RQ-BATCH-* session. The floor for a rebase batch is 2 tasks
(batcher.MIN_REBASE_BATCH): even a pair wins by serializing the two rebases.

Pure planning and parsing; no I/O of its own besides the stdin/stdout plan mode:

  python3 rebase_order.py [--size N]
    stdin: one `job<TAB>text` row per line, or a JSON list of
    [{"job": ..., "files": [...]}] / [{"job": ..., "text": ...}].
    stdout: {"batches": [[job, ...], ...], "areas": {job: "rebase:clu-<n>"}}
"""
import json
import re
import sys

REBASE_ID = re.compile(r"^RQ-REBASE-([A-Za-z0-9][A-Za-z0-9._-]*?)-(\d+)-[0-9a-fA-F]{7,40}$")
AREA_PREFIX = "rebase:"
CONFLICTS = re.compile(r'\bconflicts="([^"]*)"')
FILE_TOK = re.compile(r"\bfile=([^\s,\"']+)")
STAMPED = re.compile(r"\bcluster=([A-Za-z0-9][A-Za-z0-9._-]{0,39})\b")
PATH_OK = re.compile(r"^[A-Za-z0-9_@+.-]+(?:/[A-Za-z0-9_@+.-]+)*$")


def _path(tok):
    """A repo-relative path token, or None for noise (no schemes, no .., <=240)."""
    tok = tok.strip().rstrip(".")
    if not 1 <= len(tok) <= 240 or tok.startswith("/") or not PATH_OK.match(tok):
        return None
    return None if ".." in tok.split("/") else tok


def files_from(text):
    """The file set a rebase job names on its queue line / prompt.

    Sources: every `conflicts="a, b, c"` list (the `+N more` suffix sits outside
    the quotes and is ignored) and every `file=<path>` field.
    """
    out = set()
    for m in CONFLICTS.finditer(text or ""):
        for tok in m.group(1).split(","):
            p = _path(tok)
            if p:
                out.add(p)
    for m in FILE_TOK.finditer(text or ""):
        p = _path(m.group(1))
        if p:
            out.add(p)
    return out


def stamped_key(text):
    """The `cluster=clu-<n>` key queuegen stamps from the PR's full touched-file
    list (src/core/fleet/rebase-order.ts), or None on an unstamped line."""
    m = STAMPED.search(text or "")
    return m.group(1) if m else None


def clusters(items):
    """Connected components over shared files.

    items: iterable of (job, files-iterable). Returns a list of member lists in
    first-seen order; a job with an empty file set forms a singleton (empty sets
    never merge). Deterministic for a deterministic input order.
    """
    parent = {}
    members = []

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    seen_file = {}
    for job, files in items:
        if job in parent:
            continue
        parent[job] = job
        members.append(job)
        for f in set(files):
            other = seen_file.get(f)
            if other is None:
                seen_file[f] = job
                continue
            a, b = find(job), find(other)
            if a != b:
                parent[b] = a   # reparent is fine: only component membership is read back
    groups = {}
    for job in members:
        groups.setdefault(find(job), []).append(job)
    return list(groups.values())


def cluster_key(members):
    """`clu-<lowest PR number>` for the cluster; non-rebase ids fall back to the
    smallest job id so the key is always deterministic."""
    nums = []
    for j in members:
        m = REBASE_ID.match(j)
        nums.append(int(m.group(2)) if m else None)
    if all(n is not None for n in nums):
        return "clu-%d" % min(nums)
    return "clu-" + re.sub(r"[^A-Za-z0-9]+", "-", min(members)).strip("-")[:40]


def assign_areas(tasks):
    """Point every RQ-REBASE task's `area` at its file-overlap cluster.

    tasks: dispatchd task dicts ({job, prompt, area, ...}). A stamped `cluster=`
    key acts as an extra shared edge — the generator computed it over the PR's
    complete touched-file list — and wins as the component's area key; the
    visible conflicts/file set is the fallback. Clustering runs over the given
    candidate set only — same repo and tier, batch-eligible — which is exactly
    the grouping scope pick_members applies. Returns annotated count.
    """
    cands = {t["job"]: t for t in tasks if REBASE_ID.match(str(t.get("job", "")))}
    if not cands:
        return 0
    stamps = {j: stamped_key(t.get("prompt") or "") for j, t in cands.items()}
    # A stamped key joins the union-find as a '#cluster:<key>' pseudo-path — it
    # can never collide with a real repo path, so it only merges, never splits.
    items = [(j, files_from(t.get("prompt") or "") | ({("#cluster:" + stamps[j])} if stamps[j] else set()))
             for j, t in cands.items()]
    n = 0
    for members in clusters(items):
        stamped = sorted({stamps[j] for j in members if stamps[j]})
        key = AREA_PREFIX + (stamped[0] if stamped else cluster_key(members))
        for j in members:
            cands[j]["area"] = key
            n += 1
    return n


def batch_order(items, size):
    """Ordered batches for a generator or restock plan.

    Every batch holds members of a single cluster: the biggest clusters first
    (they carry the most re-conflict churn), members in input order, and a
    cluster larger than `size` splits into consecutive batches of at most size.
    """
    size = max(1, size)
    out = []
    ordered = sorted(clusters(items), key=lambda ms: (-len(ms), cluster_key(ms)))
    for members in ordered:
        for i in range(0, len(members), size):
            out.append(members[i:i + size])
    return out


def _items_from_stdin(text):
    """`job<TAB>text` rows, or a JSON list of {job, files} / {job, text}."""
    text = text.strip()
    if not text:
        return []
    if text.startswith("["):
        rows = json.loads(text)
        if not isinstance(rows, list):
            raise ValueError("JSON input must be a list")
        out = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("job"), str):
                raise ValueError("each row needs a string job")
            files = row.get("files")
            if isinstance(files, list) and all(isinstance(f, str) for f in files):
                out.append((row["job"], files))
            else:
                out.append((row["job"], files_from(str(row.get("text") or ""))))
        return out
    items = []
    for line in text.splitlines():
        if not line.strip():
            continue
        job, _, text2 = line.partition("\t")
        items.append((job.strip(), files_from(text2 or job)))
    return items


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--help" in argv or "-h" in argv:
        print("usage: python3 rebase_order.py [--size N]  (job<TAB>text rows or a JSON list on stdin)")
        return 0
    size = 16
    if "--size" in argv:
        i = argv.index("--size")
        if i + 1 >= len(argv) or not argv[i + 1].isdigit():
            print("usage: python3 rebase_order.py [--size N]", file=sys.stderr)
            return 2
        size = int(argv[i + 1])
    items = _items_from_stdin(sys.stdin.read())
    areas = {}
    for members in clusters(items):
        key = AREA_PREFIX + cluster_key(members)
        for j in members:
            areas[j] = key
    print(json.dumps({"batches": batch_order(items, size), "areas": areas}, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
