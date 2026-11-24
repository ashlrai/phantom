# Memory reclaim: historical proposal

## Implemented status

On the inspected `origin/master`, the original `phm mem reclaim` entry point is
absent. Its invocation examples and options in [PR #5803](https://github.com/ashlrai/phantom/pull/5803) are historical, not executable instructions for master. This document preserves its proposal, not an implementation or a promise of process or model protection.

For a current read-only view, use:

```sh
phm fleet memory --json
```

The fleet memory command reads host memory and memguard samples and reports
engine admission information. Missing or malformed sample fields remain
unknown; old samples are marked stale. It does not reclaim memory or change
dispatch or memguard state. The separate top-level `memory` command is not
evidence of reclaim support.

## Original proposal and provenance

Source: PR #5803, head `e6a6ec04cc2ef14607fdde1819ee417f2c9702cb`,
`docs/MEM-RECLAIM.md`. The proposal inventoried three classes:

| Proposed class | Inventory |
| --- | --- |
| `idle-model` | Models resident in a local inference runtime. |
| `orphaned-process` | Development processes without a live job in their ancestor chain. |
| `job-leftover` | Recorded pids of finished queue jobs still alive, and their live descendants. |

The proposal used queue status as evidence of live jobs and described a dry-run
report before any action. It sought to protect live job trees and ancestors,
the Phantom process chain, and live-job Codex processes; it also considered
pid reuse, loopback-only model endpoints, credentials, and unreadable queue
state. These are historical design intentions, not verified guarantees on
master. Missing evidence must remain unknown, not proof that a job is absent.

The original proposed model unloads and process termination are not authorized
or provided by this document. Runtime changes and other documentation from the
PR remain outside this recovery.
