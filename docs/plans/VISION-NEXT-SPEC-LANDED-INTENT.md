# Spec: refuse work whose diff is already on master (RQ-VN-LANDED-INTENT)

Rank 2 in the [vision-next roadmap](../VISION-NEXT.md#ranked-moves). This is
an implementable specification, not shipped behavior. The canonical job record
is `RQ-VN-LANDED-INTENT` in the [move manifest](vision-next.json).

## Problem

The fleet keeps doing work that has already landed:

- The [merge acceleration report](https://github.com/ashlrai/phantom/blob/master/.bridge-evidence/RQ-SWE3-MERGE-ACCEL-1-report.md)
  found 13 of 260 merges (5%) were single-parent squashes that changed no
  files. Some sat in the queue for days first. Nearly all were DRAIN, REBASE
  or CIFIX wave jobs.
- In the same window, 140 PRs were closed unmerged at a median age of 5.5
  days.

Current completion proofs are narrow:

| Check | What it proves |
| --- | --- |
| `precheck.sh` exit 10 (`id_merged_pr_N`, `pr_N_MERGED/CLOSED`) | A PR with this job ID or number reached a terminal state |
| `src/core/fleet/job-precheck.ts` `likely-done` | Paths named in the prompt exist and were last touched by a bridge commit |
| `superseded-close.ts` | A merged recut's prompt named this PR |

None of these proves that a PR's *net change* is already contained in master,
which is the case for most redundant wave work.

## Design

### Pure verdict

Add `src/core/fleet/landed-intent.ts` with an injected git port, following the
`JobPrecheckGit` pattern so no process spawn lives in the core:

```ts
export interface LandedIntentGit {
  revParse(ref: string): Promise<string | null>;                // 40-hex or null
  treeOf(commit: string): Promise<string | null>;
  mergeTree(base: string, head: string): Promise<{ clean: boolean; tree: string | null }>;
  mergeBase(a: string, b: string): Promise<string | null>;
}
export type LandedVerdict = 'landed' | 'pending' | 'conflict' | 'unknown';
export interface LandedReceipt {
  schema: 'fleet.landed-intent.v1';
  pr: number; base: string; head: string; baseTree: string; mergedTree: string;
}
export async function landedIntent(
  input: { pr: number; baseRef: string; headRef: string }, git: LandedIntentGit,
): Promise<{ verdict: LandedVerdict; receipt: LandedReceipt | null }>;
```

The rule is exact tree containment:

1. Resolve `base` (the current base branch tip) and `head`. If either is
   unknown, the verdict is `unknown`.
2. If `head` is an ancestor of `base`, the verdict is `landed`.
3. Otherwise run `git merge-tree --write-tree base head`.
   - If it is clean and the merged tree equals `base^{tree}`, the PR adds
     nothing: the verdict is `landed`.
   - If it is clean and the tree differs, the verdict is `pending`.
   - If it is not clean, the verdict is `conflict`.
4. A receipt is produced only for `landed`, and it pins all four hashes.

A revert on master between landing and the check correctly yields `pending`,
because the merged tree differs again. No model, heuristic or partial-path
match ever produces `landed`.

### Launch wiring

For queue jobs that target an existing PR (the DRAIN, REBASE, CIFIX and RECUT
families, identified by the PR number the queue row already carries), the host
`precheck.sh` calls the verdict before launch. Its tracked revisions live under
`staging/`; the live copy is installed in the runs `bin/` directory.

- On `landed`, print `SKIP <job> code=10 reason=pr_<N>_landed_<mergedTree first 12 hex>`.
  Append the full receipt as one line to `<runs>/queue/landed-receipts.jsonl`.
- On any other verdict, keep today's behavior.

Extend the two anchored receipt grammars that accept code 10:

- `contrib/mac/launch_precheck.py`, which currently accepts only
  `id_merged_pr_N` and `pr_N_(MERGED|CLOSED)`;
- `scripts/bridge/precheck.py` `apply_precheck`.

Each must accept exactly `pr_[1-9][0-9]*_landed_[0-9a-f]{12}`. Anything else at
code 10 still maps to `unproven_completion`.

### Fail directions

- **Launch is fail-open.** Errors, timeouts and `unknown` let the job run, as
  the existing precheck does. A wrong `landed` must be impossible; a missed one
  only costs a redundant run.
- **Closing is fail-closed.** RQ-VN-CONVERGE may close a PR only with a
  `landed` receipt whose `base` is still an ancestor of the current base tip
  and whose `head` still equals the PR head at close time.

### Read-only CLI

Add `phm fleet landed-check --pr <N> [--base <ref>] [--json]`, a thin handler
over the core in `src/cli/`. It emits `fleet.landed-intent.v1`, exits 0 with a
verdict and 2 on bad usage, and never fetches, writes or calls `gh`. Document
it in the CLI reference in the same change, so `test/doc-facts.test.ts` stays
consistent.

## Acceptance

Temp-repo fixtures, created with real `git` in a temporary directory, cover:

| Fixture | Verdict |
| --- | --- |
| PR squash-merged as a different commit; branch still open | `landed` |
| Head is an ancestor of base | `landed` |
| Half of the PR landed via another PR | `pending` |
| PR conflicts with base | `conflict` |
| PR landed, then reverted on base | `pending` |
| Unresolvable head | `unknown` |

In addition:

- `launch_precheck` and `apply_precheck` accept the new reason only in its
  exact grammar. Their existing tests stay green unchanged.
- The CLI performs no network access and no writes.

## Validation

```bash
npx vitest run test/fleet-landed-intent.test.ts
python3 -m unittest discover -s contrib/mac -p 'test_launch_precheck.py'
python3 -m unittest discover -s scripts/bridge -p 'test_precheck.py'
node scripts/verify-changed.mjs
npm run check:docs
```

## Expected effect

The measured upper bound is the empty-merge share (5% of merges) plus the queue
residency and CI those PRs consumed. The yield report (RQ-VN-YIELD) should
measure the realized effect as fewer `empty` attempts per day, not assume it.

## Boundaries

- This move closes no PR and deletes no branch.
- Host `precheck.sh` changes need the same Security re-pin as other
  `contrib/mac` host scripts.
