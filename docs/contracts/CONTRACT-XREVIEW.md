# CONTRACT-XREVIEW: Cross-model review and SHA-bound merge decision v1

Status: source-complete. This contract adds no merge authority. It never runs
gh and never merges. Host custody supplies scoped GitHub access for CI reads.
It produces a review record and a decision. The supervisor that holds merge rights acts on them.
Operator guide: [Cross-model review](../CROSS-REVIEW.md).

## Exports

`src/core/fleet/cross-review.ts`. All exports are pure, with no IO.

- `parseCrossReviewPolicy(raw)` and `parseCrossReviewRequest(raw)` return
  `{ ok: true, … } | { ok: false, errors }`. Both fail closed: one invalid
  reviewer rejects the whole policy.
- `reviewerLaunchProblem(reviewer): string | null` gives the launch rules.
  A claude reviewer needs the restricted argv, `-p`, a stdin prompt and text
  output. A local reviewer must be a tool-less runner. Only the family's
  model credential is passed, and `FORBIDDEN_CREDENTIAL_ENV_RE` names are
  never passed.
- `selectCrossReviewer(producer, reviewers)` picks a reviewer on another
  pool from an independent family.
- `scanSensitiveChange({ diff, repo, policy, codeowners }): SensitiveScan`,
  together with `diffPathsForReview`, `codeownersGlobs`,
  `isSelfRepoTarget` and `CROSS_REVIEW_ESCALATE_PATTERNS`.
- `buildCrossReviewPrompt(request, diff)` is the only sink for job text.
  `parseReviewVerdict(output)` accepts the closed schema
  (`REVIEW_REASON_CODES`) and nothing else.
- `decideCrossReview(input): CrossReviewDecision` and `diffSha256`,
  `isCommitSha`, `prUrl`. The optional `checks` evidence binds `headSha` to a
  hold code or `null` for success; omitted evidence holds with `checks-unreadable`.

`src/core/fleet/cross-review-process.ts`:

- `runReviewerProcess(reviewer, prompt, { parentEnv?, onScratch? }): Promise<ReviewerRun>`
  never throws.
- `buildReviewerEnv(reviewer, scratch, parentEnv)`.
- `REVIEWER_MAX_OUTPUT_BYTES`.

`src/core/fleet/cross-review-run.ts`:

- `runCrossReview(request, policy, deps?)` and
  `decideCrossReviewAtHead(request, policy, head, { pauseFile?, now? })` both
  return promises. Before approval they read live required checks and exact-SHA
  results through host custody, then re-read the PR head and stop states.
- `latestCrossReview(repo, pr)` and `loadCrossReviewPolicy(path?)`.
- `crossReviewPolicyPath`, `crossReviewLogPath`, `crossReviewPauseFile` and
  `readBoundedFile`.

`src/cli/cross-review.ts` exports `cmdFleetCrossReview(args)`, which backs
`phm fleet xreview run|decide`.

## Invariants (each covered by `test/cross-review*.test.ts`)

1. `enable-auto-merge` requires every one of the following:
   - an approve verdict;
   - recorded at exactly the head SHA the caller passes now;
   - over the same diff sha256;
   - a clean sensitive scan;
   - a reviewer on another pool and an independent family;
   - an allowed repo;
   - KILL off and PAUSE absent;
   - nonempty required checks, all completed successfully on the current head
     with matching App identities. Missing, pending, failing, stale or unreadable
     evidence holds with a structured reason; API error bodies are never logged.

   Only then is `matchHeadCommit` set.
2. If the head moved or the diff changed, the action is `re-review`. A stale
   verdict is never reused.
3. The reviewer process inherits no GitHub, git, ssh, cloud or `ASHLR_*`
   env. Its HOME, cwd and TMPDIR are a fresh 0700 scratch that is removed
   afterwards. The prompt goes to stdin, with `shell: false` and no job text
   in argv.
4. The review log and audit log hold structured fields only. They never hold
   diff text, job text, model output, env values or file paths.
5. Any malformed reviewer output, non-zero exit, timeout, oversize output or
   refused launch escalates.
