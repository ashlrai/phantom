# Branch gardener

[branch-gardener.py](../contrib/mac/branch-gardener.py) audits the nine fleet repositories
(phantom, phantom-secrets, locus, lexicon, ashlr-md, ashlr-stack, ashlr-plugin,
binshield and .github) in `ashlrai` and `masonwyatt23`. It defaults to dry-run;
no service is installed by running it. Requires Python 3.9+, Git and an existing
local `gh` sign-in. It never resolves or prints tokens. Missing repositories,
auth failures and incomplete evidence produce errors, never deletion permission.

```sh
python3 contrib/mac/branch-gardener.py --json
python3 contrib/mac/branch-gardener.py --config /absolute/branch-gardener.json --apply --json
```

## Configuration and cadence

The default config is `~/.ashlr-runs/branch-gardener.json`. Example, dry-run for
the first week, then apply on subsequent scheduled invocations:

```json
{
  "owners": ["ashlrai", "masonwyatt23"],
  "repos": ["phantom", "phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-stack", "ashlr-plugin", "binshield", ".github"],
  "pins": ["release/*", "incident/*"],
  "dry_run": false,
  "dry_run_until": "2026-11-21T00:00:00Z",
  "streams": 3
}
```

Choose an actual future date at adoption. `dry_run: true` always disables deletes;
`--apply` is also required. With no config the gardener stays dry-run indefinitely.
`owners` and `repos` may narrow the fixed allowlist. Use `owners: ["ashlrai"]`
for org-only cleanup; omit nonexistent forks from separate narrowed invocations.
Pins are additive shell globs and cannot override built-in protections.
`--runs`, `--projects` and repeated `--wt-root` select nonstandard local layouts;
the standard `<projects>/wt` and worktrees registered by the nine clones are
always inspected. The runs directory itself is also checked for worktrees.

The [launchd template](../contrib/mac/com.ashlr.branch-gardener.plist.in) runs every
21,600 seconds (six hours), with `RunAtLoad` off. Render its placeholders with
XML escaping: absolute Python/script/config/runs/home paths and a PATH containing
Git and gh. Create the logs directory before adoption. Config still controls
warmup despite the template's `--apply`. Installation is a separate host adoption
step; agents must not copy this source over live fleet machinery. There is no
new `phm` command or dispatcher dependency.

## Classification and deletion safety

- Keep both upstream and target default branch names, `main`, `master`, GitHub
  protected branches, security/pin/hold branch components and configured globs.
- Keep open PRs (including drafts), matching by head repository and branch,
  across the target and canonical upstream. Pagination has no search-result cap.
  The constitutional held PR numbers are also retained, even when closed.
- Keep local checked-out branches, detached HEAD tips, every registered linked
  worktree (including missing/locked paths), existing `wt/` job directories,
  `.base` branch records, queue run leases/markers and `queue/keep.txt` jobs.
  Conservative stale records can retain branches until separately reconciled.
- Delete a merged/closed PR branch only when its current tip equals that PR's
  head and a freshly fetched `refs/pull/<number>/head` preserves the exact tip.
  A reused branch with later commits is flagged. Closed unmerged work survives
  in the PR ref; it is not necessarily in default-branch history.
- Delete PR-less tips already ancestral to the upstream default. Otherwise,
  delete only tips older than 14 days with no unique patches (`git cherry`)
  and no unique merge commits. Age is the tip's committer timestamp, not a
  guessed branch creation time. Flag unique or recent stranded fleet work.

Git runs in a fresh temporary bare repository with no checkout or inherited Git
environment/global config, no hooks, and fixed GitHub HTTPS URLs. Fetching never
runs repository code. Streams process repositories concurrently (1–4), with at
most 100 refs per atomic `git push --delete`. Every ref has an explicit expected
SHA lease; a moved tip rejects the whole batch. No default-branch force push,
ruleset bypass, branch protection change or local branch deletion is performed.
Before each batch, the gardener refreshes defaults, protected branches, open PRs
and local activity. It also fetches the upstream default again and requires its
original proof commit to remain ancestral, holding candidates after a rewrite. The fleet KILL switch blocks writes. A singleton lock prevents
overlapping gardeners. GitHub PR/worktree state cannot be atomically locked with a
remote push; launchers and PR creators should coordinate their lifecycle with
maintenance. SHA leases close the intervening-push race, not that API-state race.

## Reports and verification

Each invocation appends private JSONL events (`plan`, `delete-intent`, `deleted`,
`result`) to `~/.ashlr-runs/metrics/branch-gardener.jsonl`, plus count-only event
breadcrumbs to `dispatch-events.log`. Plans retain per-branch reasons and SHAs;
flagged PR-less branches form the triage list. Write intent is flushed before
any push; audit failure prevents further deletion. A failed/timed-out push is
reported `failed-or-uncertain`, never optimistically counted as deleted. Re-run
from fresh evidence to reconcile; saved plans are not executable. Exit 1 means
at least one repository or required evidence source failed; successful repositories
still report their results. Refusal diagnostics withhold raw child output.

```sh
test_home=$(mktemp -d)
env HOME="$test_home" python3 contrib/mac/test-branch-gardener.py -v
```

Tests use local bare remotes only, exercising real ancestry, patch equivalence,
PR-ref preservation and atomic lease rejection without GitHub mutations.
