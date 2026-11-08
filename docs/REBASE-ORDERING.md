# Rebase batch ordering (RQ-SWE3-REBASEORDER-1)

Fleet rebase jobs (`RQ-REBASE-<repo>-<PR>-<head>`) used to batch by the dominant
directory a prompt happened to name — effectively arbitrary for multi-file
conflict sets. When two PRs that touch the same file landed in different
sessions, the first merge re-dirtied the second mid-flight: every sibling merge
meant another rebase cycle.

## The convention

Two rebase jobs belong to one **cluster** when their touched-file sets
overlap, transitively: A∩B and B∩C put A, B and C in the same cluster.

The authoritative file set is the PR's **full touched-file list**, which only
the generator has. So `queuegen` (see `src/core/drive/queuegen.ts` and
`src/core/fleet/rebase-order.ts`) clusters the repo's open PRs once per cycle
and stamps `cluster=clu-<lowest PR number>` on every REBASE line's attrs —
including membership through clean siblings that emit no line of their own.
Lines without the stamp (older cycles, other emitters) fall back to the file
set the line itself carries: the `conflicts="…"` paths plus the `file=` field
from `git merge-tree`. A stamped key is treated as one more shared edge — it
can only merge clusters, never split them — and wins as the key when present.

- **Same cluster → same batch.** One session rebases the whole cluster in
  order, so a sibling merge mid-flight is resolved inside the session instead
  of invalidating a parallel one.
- **Disjoint → spread.** A cluster never absorbs unrelated tasks, and unrelated
  task areas never absorb cluster members. A singleton cluster launches solo.
- A cluster batches at **2 members** (`batcher.MIN_REBASE_BATCH`, not the
  usual 3): even a pair wins by serializing the two rebases.
- A cluster larger than the lane's batch size splits into consecutive
  single-cluster batches; it never mixes with another cluster.
- An oversized `conflicts` list truncates at 8 paths on the line and the PR
  file listing at 100 on the API; either can only under-cluster (a sibling
  hidden in the cut-off tail), never wrongly merge.

The batching area is `rebase:<cluster key>` — the stamped key when present,
else `clu-<lowest PR number>` of the file-overlap component. It shows up in
batch ids (`RQ-BATCH-PHANTOM-CLU-41-<hash>`), the `BATCH` event's `area=`
field and the batch manifest.

## Where it lives

`src/core/fleet/rebase-order.ts` (`fileClusters`, `clusterKey`) runs inside
the generator; `contrib/mac/rebase_order.py` is the mirror the restock flow
calls (pure planning and parsing):

- `files_from(text)` — the file set a rebase job names on its line or prompt.
- `stamped_key(text)` — the generator's `cluster=` key, when present.
- `clusters(items)` — connected components over shared files; a job with no
  parseable files is a singleton and never merges.
- `assign_areas(tasks)` — rewrites each `RQ-REBASE-*` task's batching `area` to
  its `rebase:<key>` cluster area, computed over the dispatch tick's
  same-repo/same-tier candidate pool.
- `batch_order(items, size)` — the ordering for a generator or restock plan:
  biggest clusters first, every batch single-cluster.

The wiring: `dispatchd.py` calls `assign_areas` on each `form_batch` candidate
pool; `batcher.pick_members` treats `rebase:` areas as closed (no orphan
absorption either direction) with the 2-member floor; `restock.py` lets two
`RQ-REBASE` lines claim the same `file=` target in one pass (they co-batch
downstream instead of serializing one per pass). The helper ships to
`~/.ashlr-runs/bin` via `install.sh` and needs the same Security re-pin as the
rest of contrib/mac before live install.

## Try it

```sh
echo '[{"job": "RQ-REBASE-phantom-41-aaaaaaa", "files": ["src/a.ts", "src/b.ts"]},
       {"job": "RQ-REBASE-phantom-42-bbbbbbb", "files": ["src/b.ts"]},
       {"job": "RQ-REBASE-phantom-50-ddddddd", "files": ["docs/z.md"]}]' \
| python3 contrib/mac/rebase_order.py --size 4
# {"batches": [["RQ-REBASE-phantom-41-aaaaaaa", "RQ-REBASE-phantom-42-bbbbbbb"],
#              ["RQ-REBASE-phantom-50-ddddddd"]], "areas": {...}}

HOME=$(mktemp -d) python3 -B -m unittest contrib/mac/tests/test_rebase_order.py -v
```

Coverage of the conflicting-PR wave itself is a separate read-only snapshot:
`phm fleet rebase-status --repo ashlrai/phantom --json` (see
[Rebase-wave status](FLEET-REBASE-STATUS.md)).
