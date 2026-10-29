# Job outcome reconciliation

Run `./contrib/mac/metrics-outcomes reconcile --jobs /path/to/jobs.jsonl` before
reading the outcome metrics. This requires Python 3 and an existing authenticated
`gh` installation. It creates no tokens and does not publish or merge PRs.
Account access must be commissioned through Locus by the operator.

The ledger must already exist. Each publication is a JSON object with
`outcome: "PUBLISHED"`, a string `jobId`, and a `prUrl` containing the full base
repository GitHub PR URL. The legacy names `status`, `job` (or `id`), and `pr`
are also accepted. Other routing metadata is preserved. Blank lines are ignored;
malformed JSON refuses reconciliation without repairing or truncating the ledger.

Each unique job and PR is resolved with `gh pr view URL --json
state,mergedAt,closedAt`. Fork heads and squash merges need no special inference:
the PR's state is authoritative. Open PRs produce no outcome. Terminal events
retain the publication's field names, set `ts` to GitHub's merge or close time,
and include `mergedAt` or `closedAt`, `reconciledAt`, and a reconciler `source`.
Thus a historical backfill belongs to the actual merge/close window rather than
the time the repair ran. Existing MERGED or CLOSED job/PR pairs are never appended
again. This command reconciles published jobs only, not every PR in a repository.

A sibling `jobs.jsonl.reconcile.lock` serializes reconciler processes. Each append
is flushed and synced. Other ledger writers should use the same advisory lock
when appending to avoid racing reconciliation. The command rereads the ledger
before each lookup/append, preserves all original bytes and adds a missing final
newline. It never rewrites historical events. Keep the lock file in place.

Failures produce a nonzero exit and a count in the JSON summary; successful PRs
still reconcile. Failed and open PRs are retried next run. Diagnostics omit raw
GitHub output to avoid exposing credential-helper messages. A malformed ledger
or unavailable executable also fails closed. No live GitHub lookup is needed for
the fixture suite:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```

# PR titles for the bridge publisher

`contrib/mac/pr-title.sh` prints one `type(scope): summary` line at or under 72
characters for a job's pull request, or the job id when no better source
resolves. It never contacts GitHub and never fails after argument validation.
Set `PHANTOM_ROOT` to this checkout. In the external `~/.ashlr-runs/bin/publish.sh`,
keep the job id in the PR body (the existing `Automated bridge job \`$J\`` line)
and replace the literal `--title` argument with:

```bash
title=$(bash "$PHANTOM_ROOT/contrib/mac/pr-title.sh" "$J" "$R/$J.job-line" "$R/$J.diff")
gh pr create --repo "$REPO" --head "masonwyatt23:$BR" --base "$DEF" --title "$title" --body-file "$R/$J.body.md"
```

`$R/$J.job-line` is the router queue line the publisher already reads;
`$R/$J.diff` is optional — write `git diff "$BASE" "$TREE"` there before the
title call to let a loopback-only local model summarize the diff instead
(`PR_TITLE_MODEL`/`PR_TITLE_MODEL_URL` configure the endpoint; the model answer
is sanitized to one printable line and any error falls back to the router-line
title, then to the job id). The helper's own extraction drops the `JOB (meta):`
envelope and a leading `VISION` marker, keeps the first task sentence, infers a
conventional type, and scopes from `repo=`. Host deployment of the changed
`publish.sh` stays an owner step under the security pin.

Verification:

```sh
HOME=$(mktemp -d) npx vitest run test/pr-title.test.ts test/publish-sh-title.test.ts
```
