# Append-union PR conflict resolver

`phm pr resolve-conflicts --json` inspects conflicting open PRs in
`ashlrai/phantom`. It defaults to dry-run: temporary git objects and a detached
worktree are removed after inspection. It does not run repository scripts,
commit, publish, or write bundles in this mode.

```sh
phm pr resolve-conflicts --json
phm pr resolve-conflicts --repo ashlrai/phantom --pr 123 --apply --json
```

Use `--limit N` (default 500, maximum 1000) to bound the open-PR snapshot;
`complete: false` means the list hit that limit. `--pr N` inspects one PR.
`--root dir` selects the fleet runs directory (otherwise `ASHLR_RUNS_DIR` or
`~/.ashlr-runs`). The resolver requires its `queue/hold-list.txt` to be readable;
the constitution's fixed holds also apply. `--out dir` selects the bundle
directory, defaulting to `<root>/conflictres`.

## Resolution proof

Each PR is fetched at its observed head SHA into a separate temporary bare
repository. A detached worktree merges the fetched `origin/master` into that
head. The merge adds a commit; it does not rewrite the PR's history. Repository
merge drivers are overridden so `merge=union` attributes cannot hide conflicts.

Every conflicted file must be a regular text file on the exact append-union
allowlist. Every diff3 hunk must have an empty base region and nonempty
insertions on both sides. Any shared deleted or modified line refuses the
entire PR. The resolver keeps the PR insertion first, then master's insertion,
deduplicating identical inserted lines within that hunk. Surrounding lines
and cleanly merged changes remain intact.

The default allowlist is `CONTRACT.md`, `docs/README.md`,
`src/cli/completions.ts`, `src/cli/help.ts`, `notes.md`, `task_plan.md`,
`notes`, `task_plan`, `docs/llms.txt`, and
`test/fixtures/authority/tier1-closure.json`.
`--allowlist file` replaces this list with a JSON array of exact relative
paths. It cannot override GATES v3 refusals. There are no wildcard matches.

Tier-1 status alone does not refuse a proven insertion. Code conflicts outside
the allowlist, edits to shared lines, structural conflicts, GATES v3 paths
(including cleanly merged GATES edits elsewhere in the PR), and held PRs
return `needs-agent`. Reports include conflicted files and available diff3
hunks; hunk text is scrubbed and capped at 4000 characters per side. A held PR
is skipped before checkout, so its hunk list is empty. The resolver never
partially publishes a PR.

## Apply and publish

`--apply` resolves the worktree, installs frozen worktree dependencies, and
runs `npm run authority:regen` when source, test, script, or authority-generated
paths were changed by the PR. It runs `node scripts/generate-docs-llms.mjs`
for docs changes. Only declared generator outputs may change. After committing
the local merge it runs `node scripts/verify-changed.mjs` once; a failed command
or dirty verification result returns `needs-agent`. Subprocesses have deadlines
and capped output. Command logs are not printed because they may contain
private source.

Immediately before export/publication, the resolver rechecks live PR identity,
holds, and master's SHA. A moved head, changed base, new hold or master movement
requires another pass. No default branch is ever a publish target.

The current pinned `publish.sh` accepts fleet job branches and separately
reviewed integrated merges; it has no arbitrary existing-head update API.
Accordingly the CLI exports a verified bundle containing the **complete PR
delta**, including cleanly merged files, as one linear commit on the pinned
master. Its tree is identical to the verified merge tree. It returns
`ready-supersede` with the pinned base and a plan for publishing a replacement
through `publish.sh`. Import bundle `HEAD` into a new fleet job on that base
and submit it through the existing publisher. Close the original only after confirming
the replacement. Bundles are never overwritten. No raw git-push fallback or
publisher pin change is introduced.

The core's optional sanctioned publisher adapter may report `published` only
for a supported, host-validated `masonwyatt23/<repo>` fork and the original
non-default PR head. A publisher failure is reported for reconciliation;
it is never retried over another transport.

Rebase work orders from queuegen, rebase-plan, and the merge queue's drain
prompt now run this command first. Remaining `needs-agent` cases keep the agent
lane. There is no daemon job in this change: apply remains an explicit CLI
action, outside resident ticks.

## JSON and verification

The `pr.resolve-conflicts.v1` envelope carries `repo`, `dryRun`, `complete`, and
`prs`. Each PR includes pinned `head` and `base`, `files`, `hunks`, attempted
`commands`, `status`, and `reason`. Successful exports also include `commit`,
`bundle`, and `supersede`. Dry-run status is `would-resolve`; it proves the
insertion shape only, not verification success. Exit 0 means inspection
completed, including `needs-agent` rows; exit 1 means evidence was unavailable,
and exit 2 means invalid arguments.
A conflicting PR with a deleted or unavailable source repository is reported
with status `head-unavailable`; later PRs in the batch are still inspected.

Hermetic git fixtures exercise the resolver without GitHub, real home state,
or model calls:

```sh
npm run test:ci -- test/pr-resolve-conflicts.test.ts
```
