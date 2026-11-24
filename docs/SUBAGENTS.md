# Cross-provider subagents

Plan a bounded child from any session or job, without locking it to the parent's provider:

```sh
phm subagent spawn --parent session-123 --tier fast --task "Review src/core" --tools read,search --write-scope src/ --json
phm subagent list --parent session-123 --json
phm subagent result sa-0123456789abcdef --json
```

Spawn defaults to dry-run: no files, queue entries, processes or model calls.
`--apply` runs the same scope, KILL, pause, admission and quota gates, then
persists only a **held** record with `apply-inert-no-scoped-live-path`.
It does not execute the task. Refused applies are not persisted.
Before live execution can exist, the dispatchd/node-router lease must carry
the child's scope and the sandbox must enforce write scope, under Security review.

## Scope and routing

A parent matching `^sa-[a-f0-9]{16}$` must have a valid stored record;
otherwise spawning refuses with `parent-not-found`, without routing.
Stored parents must be planned, held or running; other states refuse with
`parent-state-invalid`, without routing. Valid subagent parents pass on their scope.
A non-`sa-` parent identifier is treated as a root session/job (1–128 letters,
digits, periods, underscores, colons or hyphens, starting alphanumeric).
Its fixed root scope is frontier tier, read/search/edit/test/shell tools,
`**` write scope, 200000 tokens and included cost class.
Depth starts at 1 and is capped at 3.

`--tools`, `--write-scope`, `--max-tokens` and `--max-cost-class` can narrow,
never widen, the parent scope. Tool vocabulary: read, search, edit,
test, shell, web; a root does not grant web. Tiers rank fast < mid < work <
frontier; costs rank local < included < metered. Default token limits are
16000/32000/64000/200000 by tier, capped by the parent. Absolute paths,
parent traversal and NUL are invalid; directory prefixes and trailing `/**`
contain descendants. `**` contains all relative paths.

`--task-class` accepts existing router task classes (default `other`);
`--repo` defaults to `phantom`. Routing reads models, slots, admission,
capacity and per-lane running counts from `ASHLR_RUNS_DIR` (default
`~/.ashlr-runs`). Missing running counts exclude a lane. Cost evidence comes
from the work-market posture journal; unknown classes are treated as metered,
except local-named lanes. No paid fallback is possible from root scope.
KILL active **or unknown**, pause, blocked admission and exhausted quota
fail closed. Routing is deterministic with no model backends.

## Records and results

Records live at `~/.ashlr/subagents/<id>.json` (directory 0700, files 0600,
atomic replacement). They contain a task SHA-256 digest, never raw task text.
List returns direct persisted children sorted by creation time. Malformed,
symlink and oversized record files are ignored. Result reads only metadata
and a reference, never content. The non-CLI `recordSubagentResult` API accepts
held/running → completed/failed, with a bounded `run:`, `pr:`, `proposal:`,
`job:` or `artifact:` reference.

CLI exit codes: 0 success, 1 refused or result missing, 2 invalid usage.
`--dry-run` and `--apply` together are invalid. `--help` exits 0 without I/O.
See [the contract](../CONTRACT.md#cross-provider-subagents-subagentv1).
