# Preservation evidence: PR #4501 (RQ-EMPTYRETRYRECONCILE223S)

Reconcile of original PR #4501 (`RQ-EMPTYRETRYN9RQ8`) against current
`origin/master` (`0427b167f1aec975905a05203d54452a33dd70a9`). Original
implementation commit: `cb3c7fe46ea7c27e3933fd92afb4b43924ce3568`
("bridge(RQ-EMPTYRETRYRECONCILE223S)" lineage; authored Nov 9 2026). The PR head
 inspected was `7548d0c3e8` (merge of master into the PR branch). This worktree
is shallow; per-file landing commits on master are not resolvable beyond the
shallow boundary, so evidence is pinned to file content at the master SHA above.

## Path-by-path audit

### `src/core/fleet/empty-jobs.ts` — IDENTICAL

`git show cb3c7fe…:src/core/fleet/empty-jobs.ts | diff - src/core/fleet/empty-jobs.ts`
produces no output. All original behavior is byte-preserved:

- `EMPTY_CLASSES` includes `too-broad` and `tests-timeout`.
- `labels` and `counts` cover the two new classes.
- Classification rules for `too-broad`, `tests-timeout`, and the widened
  `already-done` (`no changes needed`) pattern are present verbatim.
- `readEmptyJobs` still tails `BRIDGE_NOTES.md` under `ASHLR_WT_DIR` and
  `<id>.log` under `ASHLR_RUNS_DIR` with `O_NOFOLLOW`, 64 KiB bound, 16-wide
  batching.

### `test/jobs-retry-empty.test.ts` — IDENTICAL

Byte-identical to the original (48 lines). Covers classification, planning
eligibility (too-broad/tests-timeout only, route attrs required, CLAIMED-line
matching), and the preview/apply/receipt retention cycle.

### `src/cli/jobs-retry-empty.ts` — PRESERVED, one superseding fix

97 lines both. Single difference at the mode parser (original line 70):

- Original: `mode = arg.slice(2) as typeof mode;`
- Current: `mode = arg === '--dry-run' ? 'dry-run' : 'apply';`

The current explicit ternary is a strict improvement (no cast, same semantics
for the two accepted literals) and is kept per tasking. Everything else is
byte-identical: `planEmptyRetries` eligibility filter
(`too-broad`/`tests-timeout`, exactly one matching queue entry, no
`retry-empty-source=` on the source, required `repo=`/`pool=`/`tier=` attrs,
valid tier vocabulary, retry-id dedupe), the `RQ-EMPTYRETRY-<sha256[:20]>`
naming, the appended READY line preserving `pool`/`tier`/`repo` and embedding
the original goal, the python3 `fcntl` locked writer (regular-file check,
before/after snapshot compare, `O_EXCL` receipt files fsynced before the
queue, atomic `os.replace`), receipt dir at `<queue>/empty-retry-receipts`,
`--dry-run`/`--apply`/`--json`/`--file` parsing, exit codes 0/1/2, and the
`jobs.retry-empty.v1 {applied,lines}` JSON shape.

### `src/cli/jobs-empty.ts` — PRESERVED plus additive help guard

Original dispatch line is present verbatim:

```ts
if (args[0] === 'retry-empty') return (await import('./jobs-retry-empty.js')).cmdJobsRetryEmpty(args.slice(1));
```

and the usage string still documents both verbs. Current adds one earlier
line (post-dates the PR): a `--help`/`-h` single-arg early return before the
dispatch — additive, does not change retry-empty routing.

### `src/cli/help.ts` — PRESERVED

The agent-command entry exists at line 183:

```ts
{ usage: 'phm jobs retry-empty --dry-run|--apply [--file <router-queue.md>] [--json]', description: 'Preview or queue one scoped retry per eligible empty job.', safety: 'append', jsonShape: 'jobs.retry-empty.v1 {applied,lines}' },
```

Same usage/description/safety/jsonShape as the original hunk; the surrounding
catalog has since grown many unrelated entries (bus, wb, verify done, etc.).

### `docs/QUEUE.md` — PRESERVED

The `### Retry empty jobs` section exists verbatim (lines 332–345), including
the dry-run/apply/`--json`/`--file` semantics, original-route preservation,
unambiguous-entry requirement, duplicate/already-done exclusion, durable
`empty-retry-receipts` behavior, and the crash-window caveat. Later sections
(queuegen dedupe, generator yield, queue stuck) were inserted around it; the
retry section text is unchanged.

## Behavior-to-evidence map

| Original behavior | Current evidence |
| --- | --- |
| Classify empty outcomes into `too-broad`/`tests-timeout` (+widened `already-done`) | `src/core/fleet/empty-jobs.ts` identical; `test/jobs-retry-empty.test.ts` `classifies %s` cases |
| Plan one retry per eligible job, preserving repo/pool/tier and shrinking the goal | `planEmptyRetries` identical; original test `plans only eligible jobs…`; new `jobs-retry-empty-original-preservation-223s.test.ts` asserts `pool=codex-personal`, `tier=work`, `repo=phantom` on the emitted line |
| Skip ambiguous (>1 matching entry), unrouted (missing attrs), ineligible-class, and already-`retry-empty-source=` sources | Same code path; new test feeds RQ-TMO (two matching lines), RQ-NOROUTE (no attrs), RQ-DONE (already-done), RQ-MISC (other), RQ-AGAIN (retry-empty-source present) and asserts no `retry-empty-source=<id>` for any of them |
| Dry-run mutates nothing | New test: `--dry-run --json` leaves queue bytes identical and creates no `empty-retry-receipts` dir |
| Apply appends exactly one retry, preserving unrelated queue bytes | New test: post-apply file `startsWith` the original mixed queue; exactly one `retry-empty-source=` and one `RQ-EMPTYRETRY-` occurrence; unrelated READY/DONE/CLAIMED/comment lines intact |
| Durable receipts survive queue-line removal | New test: after apply, queue rewritten without the retry line, second `--apply --json` returns `lines: []` and leaves the file untouched |
| Locked, snapshot-checked, receipt-before-queue writer | `writer` python block byte-identical; exercised end-to-end by both test files via real `spawnSync('python3', …)` |
| CLI wiring (`phm jobs retry-empty`), help entry, QUEUE.md docs | `jobs-empty.ts` dispatch, `help.ts` line 183, `docs/QUEUE.md` §Retry empty jobs — all present |

## Superseding fixes kept (not regressions)

1. Mode parser ternary replaces the original `arg.slice(2) as typeof mode`
   cast — same accepted literals, no cast. Kept.
2. `jobs-empty.ts` gained a `--help`/`-h` early return — additive.
3. `help.ts` and `QUEUE.md` hunks landed in files that have since grown;
   positions shifted, content preserved.

## Gaps

None found. All six original paths are present on `origin/master` with the
original behavior intact or strictly improved. The only unverifiable-by-diff
item is the per-file landing commit on master (shallow clone boundary); content
equality at `0427b167f1` is the evidence used.
