# Mac bridge launch and publish coordination

These are operator-installed replacements for `~/.ashlr-runs/bin/launch.sh`
and `publish.sh`. Nothing in this change installs, launches a real provider,
pushes, or publishes automatically. Requires macOS, Bash 3.2+, Python 3.9+,
Node 22.15+, Git, and the existing authenticated provider CLIs, `gh`, sandbox
profiles and model configuration. Keep the operator's trusted executable PATH.

## Install after merge

Drain the old bridge first: stop admitting jobs and verify every old launch,
publish and agent has exited. The old mkdir locks cannot coordinate with the
new kernel locks; never run both generations concurrently. Do not delete a
lock to get past a live holder. Retain the old scripts for rollback.

From the merged repository, copy the following complete set together:

```bash
install -m 700 scripts/mac-bridge/launch.sh scripts/mac-bridge/publish.sh \
  scripts/mac-bridge/bridge.py "$HOME/.ashlr-runs/bin/"
install -m 600 scripts/mac-bridge/agent-rules.txt \
  scripts/bridge-worktree.mjs scripts/bridge-clone.py "$HOME/.ashlr-runs/bin/"
```

The two dependency helpers incorporate RQ-MAC-WTCLONE (PR #963). See
[dependency preparation](../../docs/BRIDGE-WORKTREES.md) for manifest parity,
native APFS cloning, the five-second fallback, the fixed 20 GiB disk floor,
and the shared-write implications of a symlink fallback. Installers must not
change the source dependency installation while launches reuse it.

Export a **new run ID once per queue sweep**, inherited by every parallel
launch in that sweep. A missing/invalid ID refuses before launching. Do not
reuse an ID across sweeps: successful base resolution and failed fetches are
both cached for that ID. A failed fetch requires a new sweep ID to retry.

```bash
export BRIDGE_RUN_ID="queue-$(date +%Y%m%dT%H%M%S)-$$"
# The queue runner launches independent job invocations concurrently:
"$HOME/.ashlr-runs/bin/launch.sh" JOB phantom codex-cmp frontier < JOB.prompt
```

`BRIDGE_RUNS_DIR` and `BRIDGE_PROJECTS_DIR` override the normal
`~/.ashlr-runs` and `~/Projects/ashlrai` roots for isolated testing. Job/repo/run
IDs accept ASCII letters, digits, dots, underscores and hyphens, starting with
a letter or digit (128 characters maximum). Legacy `.base` records are
preserved, so worktree paths containing whitespace are refused. Keep existing
sandbox profiles and provider credentials outside the repository. This change
creates no secrets, changes no account selection, and logs no credential values.

## Coordination and recovery

- One fetch per repository common Git directory and run ID, including failure
  caching. Fetch has a 20-second command limit; lock waits are bounded.
- A separate short repository lock covers only `git worktree add --no-checkout`.
  Checkout, dependency cloning and agent startup run concurrently per worktree.
- A canonical-worktree kernel lock spans setup and the entire agent session.
  Publish uses the same lock. Live claims refuse immediately. `cat` keeps agent
  stdout/stderr on pipes for sandboxed Node compatibility.
- Lock files persist and are never unlinked or force-broken. Kernel ownership
  releases when the last inherited descriptor closes. Recorded PID, process
  start identity, age (at least one second), and worktree binding supplement
  the kernel lock. A live agent claim blocks even if it closed inherited FDs;
  unknown PID identity blocks conservatively. Age alone never permits takeover.
- A killed/failed launch may leave an incomplete worktree. It refuses reuse
  rather than resetting possible user edits. Inspect its `.base`, `.claim` and
  `.prepared` records and worktree manually. Existing pre-install worktrees
  lack `.prepared`; reconcile them only after verifying ownership and completion.
  Malformed claim/lock metadata also requires operator review.
- A reused, completed worktree retains its original base and must match the
  requested repository, branch and pool. No fetch is needed to reuse it.

Readiness means the actual sandbox/provider process was spawned and remained
alive through a short startup check. It does not prove remote authentication,
model response, or a completed task. A 30-second caller timeout reports a held
launch; it never kills a holder or authorizes a duplicate. Inspect the claim
before retrying. Network/filesystem stalls can exceed the local benchmark.

## Publishing and deletion approval

`publish.sh JOB` writes `JOB.publish`. Its **pre-lock** read-only empty check
compares net tracked and untracked content with the recorded base, excluding
`BRIDGE_NOTES.md`. Notes-only and truly empty jobs return `RESULT EMPTY`
without taking a bridge lock, testing, committing, or calling GitHub. Uncommitted
agent edits remain publishable; they are not mistaken for empty jobs.

The publisher repeats the check after acquiring the worktree lock, constructs
its candidate in a private Git index, and refuses protected paths, CODEOWNERS
matches, and skip-worktree entries before changing HEAD or the real index.
Refusal preserves the agent's files and notes. More than **500 deleted lines**
across the complete base-to-candidate diff (renames disabled), or uncountable
changes/deletions to an existing binary, require `DELETIONS-OK` as an exact
whitespace-delimited token on the single trusted queue job line stored at:

```text
~/.ashlr-runs/JOB.job-line
```

The queue operator must capture that line from the approved queue entry.
Prompt text and agent notes cannot authorize deletions. A new binary does not
count as an unknown deletion. Approval does not bypass protected-path gates.

Nonempty publishing retains the original fork/PR/auto-merge flow. It creates
one commit on the recorded base and reuses the same commit on retry; pushes
are never forced. Fork URLs are passed directly instead of mutating shared Git
remote configuration. Notes remain in the worktree and are copied to run state.
Full tests remain opt-in (`PUBLISH_FULL_TESTS=1`); failures then block publishing,
and dependencies must already be prepared. Test output stays in local logs,
not in PR excerpts. Required CI and branch protection remain the merge gate.

## Timing stations and verification

Append-only `queue.v1.jsonl` records have `schema: "queue.v1"`, `job`, `run_id`,
`station`, `timestamp` (Unix seconds), `duration_ms`, and `outcome`. Stations are
`fetch`, `worktree`, `dependencies`, `launch`, `session`, and `publish`.
Launch duration includes setup and process startup; publish duration includes
preflight and any lock refusal. The external queue's existing station schema
was not available in this checkout: map these fields in its collector before
claiming live dashboard compatibility. Records contain no prompts or tokens.

```bash
HOME=$(mktemp -d) bash scripts/mac-bridge/test.sh
HOME=$(mktemp -d) npx vitest run test/bridge-worktree.test.ts
```

The Bash suite uses real Git worktrees and kernel locks with local fixtures and
stub provider/GitHub CLIs. It measures 20 concurrent starts against the 30-second
threshold, counts fetches and duplicate attempts, and tests crash recovery,
publish refusals, deletion approval and station logging. Run the same 20-job
measurement on the installed bridge for production acceptance; the fixture
cannot establish live Phantom checkout or provider latency.
