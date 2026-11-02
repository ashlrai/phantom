# Mac router supervisor

Run one deterministic orchestration tick from launchd. Jobs go to configured
Codex/Claude pool adapters; a separate, fresh, tool-free inference process reviews
their immutable PR diffs. Only the deterministic host process can approve and
request squash auto-merge. Nothing is installed or activated by this contribution.

## Commissioning contract

The operational queue, seven-repo allowlist, bridge denylist, ENGINEER-RULES and
FLEET-1-USAGE adapter are absent from this checkout. Supply them as owner-controlled
inputs. **Do not give this service merge rights until Security reviews it and
verifies the following prerequisites.** No approval file is shipped.

- A dedicated non-root Mac job account, distinct from the supervisor UID. Mason
  configures narrowly scoped non-interactive sudo to that account. The job account
  must have no supervisor group access, keychain access, or write access to the
  runtime checkout, Node, tsx, its dependencies, adapters, or their parent directories.
  Run the supplied sandbox tests and a deployment-specific separate-UID probe.
  Separate HOME alone is insufficient. A failed identity/sudo/sandbox probe refuses
  dispatch. No account, sudoers or credential changes are made here.
- A canonical, mode-0700 control directory and a separate canonical, mode-0700
  supervisor HOME owned by the supervisor UID. All control files are mode 0600.
  Store the fine-grained PAT only in that HOME's `.config/gh/hosts.yml`, not in the
  service environment or shared keychain. Jobs receive a new HOME and `env -i`;
  the Mac sandbox denies supervisor/control reads, runtime writes, loopback
  connections, process inspection, signals, POSIX IPC and Mach lookups. Adapters
  must operate within those restrictions. No same-UID fallback exists.
- The PAT has only contents write and pull-requests write on the approved base
  repositories, with no administration, workflows, secrets or organization scope.
  Masbot must ask Mason to create it; this code never creates or broadens tokens.
  A fine-grained PAT has one resource owner: base-repo and personal-fork access
  may need separate credentials. Fork credentials belong to the job account;
  never widen the supervisor token to compensate. The reviewer identity must
  differ from the PR author (GitHub refuses self-approval).
- Each repository is public. Reads first verify public visibility, then use the
  same isolated, narrow PAT through deterministic `gh` calls to avoid anonymous
  rate limits. Public [check-run reads](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
  require no additional Checks permission. Unavailable, private, rate-limited,
  incomplete or unknown evidence holds work. Never broaden the token's scope.
- Branch protection requires approving reviews, dismisses stale approvals when
  new commits arrive, and requires all configured CI checks. The bot's SHA-bound
  approval must be required for the fork lane; an unrelated approval cannot
  authorize a changed head. No bypass actors may substitute for this guarantee.
  Security verifies this server-side policy out of band; the token intentionally
  cannot inspect or alter administration settings. `--match-head-commit` alone
  does not bind a previously enabled auto-merge to future pushes.
- Security maps **every canonical ENGINEER-RULES hard limit** to enforced controls
  in the adapters and supervisor before attesting `hardLimitsMapped`. Supplying
  those rules in a prompt is not deterministic enforcement. This implementation
  enforces at most two attempts per immutable job, one outstanding auto-merge,
  three merges per repo per rolling hour, and a global rolling 24-hour cap of at
  most ten. Lower the cap when canonical policy requires it. Pool adapters must
  enforce resource, usage, spend, path and execution limits from FLEET-1-USAGE.

## Control directory

`config.json` has exactly these fields (replace all seven fictional repo names
with the canonical allowlist; this is a schema example, not activation policy):

```json
{
  "repos": ["ashlrai/example-one", "ashlrai/example-two", "ashlrai/example-three", "ashlrai/example-four", "ashlrai/example-five", "ashlrai/example-six", "ashlrai/example-seven"],
  "pools": {"codex": {"executable": "/opt/router/pool-adapter", "args": ["codex"]}},
  "box": {"executable": "/opt/router/box-adapter", "args": []},
  "jobUser": "rqjobs",
  "gh": "/opt/homebrew/bin/gh",
  "supervisorHome": "/Users/router-owner/gh-home",
  "reviewer": {"endpoint": "http://127.0.0.1:11434/api/chat", "model": "approved-review-model"},
  "dailyCap": 6,
  "denylist": ["private/**"],
  "requiredChecks": {
    "ashlrai/example-one": ["CI"], "ashlrai/example-two": ["CI"],
    "ashlrai/example-three": ["CI"], "ashlrai/example-four": ["CI"],
    "ashlrai/example-five": ["CI"], "ashlrai/example-six": ["CI"],
    "ashlrai/example-seven": ["CI"]
  },
  "maxDiffBytes": 262144
}
```

The reviewer endpoint uses the [Ollama chat protocol](https://docs.ollama.com/api/chat)
on IPv4 loopback at an explicit port. Provision an approved local model or a
trusted compatible Codex/Claude inference relay. It must be stateless and expose
no tools or agent execution. No model is downloaded or billed by setup. Each
review uses a new Node process, fresh HOME, only two messages, `tools: []`, JSON
output, no model/gh credential, and no task scratch/history. Free-form model output
never leaves that process. Approve has no reasons; reject uses bounded reason
codes: `quality`, `security`, `tests`, `scope`, `uncertain`.

Place canonical rules in `ENGINEER-RULES.md`. Place exactly `initialize` followed
by a newline in a one-use `INITIALIZE` file for the first tick. A missing or
corrupt `fleet.json` subsequently refuses to reset accounting. Back it up as
operator state. Never re-initialize it to clear a limit.

After review, Security supplies `security-approval.json` with exactly `source`,
`policy`, `rules` (SHA-256 digests), `expiresAt` (Unix milliseconds, at most seven
days away), and these true attestations: `staleReviewsDismissed`,
`requiredApprovals`, `credentialScopeVerified`, `hardLimitsMapped`,
`isolationVerified`. `policy` and `rules` hash the exact file bytes. Obtain the
source digest by importing `sourceDigest()` from `supervisor.ts`. Changed source,
policy, rules or expired approval stops dispatch/merge and disables tracked
auto-merge requests. Imported protected-path policy and the pinned dependency
runtime remain part of Security's reviewed, read-only deployment image.

## Queue and adapter protocols

`router-queue.md` contains exactly one fenced JSON array. Other Markdown is ignored:

````markdown
```router-jobs
[{"id":"RQ-EXAMPLE","repo":"ashlrai/example-one","pool":"codex","prompt":"Fix the arithmetic defect and return the fork PR number."}]
```
````

Queue text is untrusted. Jobs cannot choose executables, arguments, paths, repo
owners, credentials or limits. Prompts go over stdin only. IDs are immutable;
changing an existing job's content quarantines it, and duplicate IDs reject the
whole read. A new attempt uses the same PR for repair. Queue reads log a structured
diff of IDs and before/after hashes; no raw Markdown or prompt is logged.

A pool adapter reads a single JSON object from stdin:
`{repo,prompt,rules,repairPr,limits}`. `repairPr` is null on first dispatch or an
integer to repair the existing fork PR. Stdout must be exactly `{"pr":123}` or
`{"failed":true}`. Send diagnostic output to a separate, access-controlled system;
the supervisor discards stderr. An explicit failure requeues once. A lost reply,
invalid output, timeout or crash is an unknown outcome and latches a halt; it is
never automatically replayed. No adapter is fabricated for the absent usage pool.

The box adapter reads `{"exception":{...}}` with structured fields only. It wakes
Grok for denied paths, security findings, rejected reviews, exhausted repairs or
latched failures. Normal pending CI, caps and routine success do not wake it.
It runs under the same isolated job account, never with supervisor credentials.

The deny gate covers current and renamed paths, built-in Tier-1 rules, CODEOWNERS
at the exact base SHA, `.github`, scripts, manifests/locks, build.rs, Vercel config,
the bridge denylist and this supervisor itself. A conservative patch scan sends
network, environment, credential and dynamic execution changes to the box. Binary,
truncated, symlink and unsupported diffs refuse. Test weakening refuses. The review
diff comes from immutable `base...head` compare endpoints; head/base/diff/files
and deny policy are checked again before deterministic SHA-bound approval and
`gh pr merge --auto --squash --match-head-commit`.

## Scheduling, pause and recovery

With prerequisites reviewed and explicitly authorized, a launchd LaunchAgent can
invoke this command on a 60-second `StartInterval`, with `RunAtLoad` true and an
absolute `WorkingDirectory` pointing to the reviewed checkout:

```sh
/absolute/path/to/node --import /absolute/path/to/checkout/node_modules/tsx/dist/loader.mjs /absolute/path/to/checkout/contrib/router/supervisor.ts /absolute/path/to/control
```

Use the five corresponding `ProgramArguments` entries (Node, `--import`, loader,
script, control). Install/enable the LaunchAgent only after commissioning; no
plist, launchd installation, or service permission change is included here.
An atomic `tick.lock` directory prevents overlapping ticks. A crash leaves that
lock in place: the box verifies no supervisor is alive, then removes it and any
unrenamed `fleet.next` before restarting. Never auto-reap a lock by age.

Create `PAUSE` in the control directory to stop new work. Cancellation runs before
fallible GitHub reads and queue parsing. Every merge request checks PAUSE again.
Cancellation retains reconciliation obligations: a PR that raced cancellation
may already have merged. Main CI must be green before another auto-merge; red
main or two observed reverts latch a halt. Unknown CI holds. Revert detection
recognizes Git's standard full-SHA `This reverts commit ...` trailer in recent
default-branch commits, including squash-merged standard revert PRs; manual or
nonstandard reversions require the box to pause the service.

The box investigates, verifies/repairs main, and writes the exact halt code plus
newline into mode-0600 `CLEAR-HALT`. That acknowledges old reverts without erasing
reservations or replaying unknown jobs. Paused or halted ticks disable tracked
auto-merge before returning. GitHub cancellation requires connectivity; a local
file cannot revoke a remote request instantaneously. During outage or service
failure the box must also disable outstanding requests directly on GitHub.

`fleet.json` and `events.jsonl` contain schemas, job IDs/hashes, PR numbers, repos,
SHAs, verdict/reason codes, timestamps and check names/states only. No diff, raw
model output, queue prompt or environment is persisted. Monitor generic process
failure exit status as well as structured exceptions; quota reservations survive
ambiguous responses, crashes and old pending requests. Actual observed merge
timestamps settle reservations. Confirmed cancellations conservatively count at
the cancellation time. No audit retention or ledger deletion runs automatically.

## Local verification

Run from the checkout with a temporary HOME. The native boundary tests need macOS
and permission to apply a nested sandbox and bind a local mock inference server;
they never contact GitHub or use real credentials.

```sh
HOME=$(mktemp -d) node --import tsx --test contrib/router/supervisor.test.ts
HOME=$(mktemp -d) ./node_modules/.bin/tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --strict --skipLibCheck contrib/router/*.ts
HOME=$(mktemp -d) npm run typecheck
HOME=$(mktemp -d) npm run lint
HOME=$(mktemp -d) npm run check:docs
```

Root TypeScript and Vitest discovery do not include `contrib/router`; run both
explicit commands above. Passing local tests is source evidence, not Security
approval, separate-account commissioning or live merge acceptance.
