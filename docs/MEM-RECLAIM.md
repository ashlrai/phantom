# Memory reclaim

`phm mem reclaim` inventories resident memory on the operator machine and
reclaims exactly three classes of it. It is a dry run by default; `--apply`
performs the listed actions.

```sh
phm mem reclaim            # JSON report, changes nothing
phm mem reclaim --apply    # perform the reported kills and unloads
```

## What it reclaims

| Class | What | How |
| --- | --- | --- |
| `idle-model` | Models resident in a local inference runtime | Unloaded only through the runtime's own loopback API: Ollama `POST /api/generate` with `keep_alive: 0` at `http://127.0.0.1:11434`, oMLX `POST /admin/api/models/{id}/unload` at `http://127.0.0.1:8000` |
| `orphaned-process` | `node`, `tsserver`, `rust-analyzer`, `esbuild` and `cargo` processes whose ancestor chain contains no live job pid | SIGTERM, then SIGKILL after the grace window |
| `job-leftover` | Pids a finished router queue job recorded that are still alive, plus their live descendants | Same kill sequence |

Live jobs come from `~/.ashlr-runs/queue/status.json` (falling back to the
`queue.v1.json` snapshot in the same directory); `--queue-status <path>` reads
another file. A job is live when its status is claimed or running, or when any
of its claims lacks `finishedAt`.

## What it never does

- Never kills a pid inside a live job's process tree, a live job's ancestor
  chain, or the `phm` process chain itself.
- Never kills a codex process attached to a live job. Codex is only reclaimable
  as the directly recorded pid of a finished job, and a pid that started after
  the job finished (pid reuse) is skipped with a reason.
- Never unloads through a non-loopback endpoint; the base URLs are normalized
  and refused before any request.
- Never sends credentials anywhere. An oMLX admin API that requires auth is
  reported as skipped, not fought.
- Never reads or touches auth files (`~/.codex*`, keychains, env secrets).
- Fails closed when the queue status file exists but cannot be read or parsed:
  every action degrades to `skip` and `--apply` exits nonzero. A missing file
  means no live jobs exist.

## Report

The dry run prints `mem-reclaim.v1` JSON: a per-entry `{ pid, class, name,
rssKb, reason, action }` list plus queue status provenance, protected pid count
and reclaimable totals. `--apply` adds `result` and `detail` per entry.

## Flags

| Flag | Effect |
| --- | --- |
| `--apply` | Perform the reported actions (default is report only) |
| `--queue-status <path>` | Read this router queue snapshot instead of the default |
| `--ollama-url <url>` | Ollama base URL, loopback only (default `http://127.0.0.1:11434`) |
| `--omlx-url <url>` | oMLX base URL, loopback only (default `http://127.0.0.1:8000`) |
| `--no-models` | Skip the idle-model probe entirely |
| `--vmmap` | Enrich candidates with per-process swapped-out memory (macOS, best effort) |
| `--grace-ms <n>` | Milliseconds between SIGTERM and SIGKILL (default 3000) |

The safety rules are implemented in `src/core/memory/reclaim.ts` and exercised
against a fake process table and fake queue status in
`test/mem-reclaim.test.ts`; OS effects are isolated in
`src/core/memory/system-deps.ts`.
