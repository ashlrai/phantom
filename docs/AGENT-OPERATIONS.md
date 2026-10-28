# Agent operations guide

A cold-start checklist for a coding agent that must build this repository, or
install and operate Phantom. Every command here exists in the current source
(`phm --help`, `phm help <topic>`, `phm <command> --help`); where a capability
is gated or unverified, this guide says so. The binary you run is the authority:
an older install may lack commands described here.

`phm` and `ashlr` are the same binary (`package.json` `bin`). Help text uses
either name.

## 1. Working on this repository

| Need | Command |
| --- | --- |
| Node version | `>=22.15.0` (`package.json` `engines`) |
| Install dependencies | `npm ci` |
| Build `dist/` (CLI, assets, web console, build identity) | `npm run build` |
| Run the CLI from source, no build | `npm run dev -- <command>` or `npx tsx src/cli/index.ts <command>` |
| Run the built CLI | `node bin/ashlr <command>` (shim that imports `dist/cli/index.js`) |
| Install the source build on `PATH` | `./install.sh` (builds, symlinks `bin/ashlr` into `~/.local/bin`) |
| Type check (backend + web) | `npm run typecheck` |
| Lint (ESLint + real-I/O lane + Phantom console sync-I/O guards) | `npm run lint` |
| Backend tests | `npm test` (all), `npx vitest run test/<file>.test.ts` (focused) |
| Backend tests with isolated homes and a runtime cap | `npm run test:ci -- <files>` |
| Web console tests | `npm run test:web` |
| Safety invariant suites | `npm run test:invariants` |
| Documentation links and anchors (offline) | `npm run check:docs` |
| Duplicate test names across `test/` (describe path + title) | `node scripts/check-test-names.mjs` |
| Fast local gate: build, static checks, related tests, smoke set | `npm run gate` (`-- --base <ref>`, `-- --json`) |
| Full gate: complete backend and web suites | `npm run gate:full` |
| Release-readiness subset | `npm run check:release` |

`npm run gate` writes to `.ashlr-gate/` and `dist/`. It selects tests through
the import graph, so a test that reads a changed file as text is not selected;
name it explicitly or use `gate:full`. Neither replaces hosted CI or the
[release guide](RELEASING.md).

**Hosted CI.** `Merge Gate` fails unless every job in the selected CI lane
succeeded. On a pull request the four `Mac exhaustive (N/4)` shards are skipped
unless the PR carries the `ci:full-mac` label, and `Merge Gate` counts them as
deferred to post-merge; they always run on master pushes. `Mac exhaustive
(isolated)` and the other macOS checks run on every pull request that is ready
for review. A draft pull request skips those until it is marked ready, which
starts a full run; a draft cannot merge, so open drafts while iterating
and mark the PR ready once Linux is green (`.github/workflows/ci.yml`).

**Tests.** Backend suites live in `test/` and are named after the milestone or
release that introduced them: `test/m<N>.<topic>.test.ts`, invariant suites
`test/h<N>.*.test.ts`, and `test/<topic>-<release>.test.ts`. Web tests sit next
to their components as `src/web-ui/**/*.test.{ts,tsx}`. Tests that do real I/O
must be listed in `test/config/realio-lane-membership.mjs` (`npm run lint`
checks this). Every test runs with an isolated `HOME` (`test/setup/home.ts`),
and writes under the real `~/.ashlr` fail the test.

**Layout.** `src/cli/` holds thin argv dispatchers, one file per command group;
`src/core/` holds the logic; `src/web-ui/` the React console; `desktop/` the
desktop app; `scripts/` build, gate and check tooling. See
[CONTRIBUTING.md](../CONTRIBUTING.md#project-layout) and
[ARCHITECTURE.md](ARCHITECTURE.md).

**Docs.** The map is [docs/README.md](README.md). `scripts/check-documentation.mjs`
checks the operator entrypoints in its `OPERATOR_DOCUMENTATION` list. Each of
those (except `README.md`) must also appear in `package.json` `files`
(`test/documentation-navigation.test.ts`). A packaged guide must link to an
unpackaged one through a `https://github.com/ashlrai/phantom/blob/master/...`
source link, which the checker resolves locally.

### Merged-PR router queue

`phm fleet queue` supplies the RQ bridge with follow-up work. It does not run
jobs or grant review/merge authority. The bridge must deliver **every** verified
GitHub merge (including manual and external merges), retry failed ingestion,
and replay missed events after downtime. The internal `merge:shipped` event
also enqueues authenticated inbox merges when configured; that event is best
effort and is not a complete GitHub event feed.

The operator provisions `~/.ashlr/router-queue/` (0700) and `config.json`
(0600) in the supervisor's HOME, outside every job HOME. Configuration has
exactly the keys `v: 1` and `repositories`, an array of exactly seven unique,
lowercase `ashlrai/<repo>` names from the owner's approved scope. There is no
inferred/default repository list, and forks are not queue targets. Keep this
configuration and the queue's metadata sidecars inaccessible to jobs. Do not
give workers this HOME or the supervisor's environment/credentials.

After independently verifying a PR is merged, the bridge pipes a JSON object
to `phm fleet queue merged --json` on stdin, with exactly these fields:

```json
{
  "v": 1,
  "state": "MERGED",
  "prUrl": "https://github.com/ashlrai/phantom/pull/42",
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "mergeSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "mergedAt": "2026-01-01T00:00:00.000Z"
}
```

This is an example envelope, not evidence that this PR merged. The stdin
adapter validates shape and scope; it cannot authenticate a GitHub event by
itself. Only the trusted bridge should call it with verified metadata.
An accepted PR creates one deterministic follow-up asking for the next bounded,
evidence-supported improvement. Replay is idempotent, even after completion;
conflicting SHA/time metadata for the same PR is refused.

`phm fleet queue ask --json` reads one `ask.v1` record on stdin —
`{schema:"ask.v1",id,tier,pool,priority,repos,task}` — and prints its fanout
as a `queue.v1` document: N READY jobs, one repo each, N by tier (work 1, mid
2, frontier 3) over the first N listed repos. Every repo must be one of the
seven configured `ashlrai/<repo>` names; a malformed or out-of-scope ask fails
whole. The projection is deterministic, so replayed asks dedupe by job id at
the queue store, and it mutates nothing: no receipts, queue file or audit log
are written. `task` stays untrusted prompt data on each emitted job.

`phm fleet queue read --json` returns `{v:1,jobs:[{jobId,repo,prompt}]}`.
The bridge passes `prompt` only as untrusted model input, never as shell,
command arguments, configuration, an execution path, or authority. It must
not copy prompts into `fleet.json` or logs. This command is a snapshot, not a
worker lease: the existing supervisor must serialize assignment/claim work
before dispatch. When work finishes, the trusted supervisor acknowledges it
with `phm fleet queue complete <job-id> --json`.

`router-queue.md` holds JSON data in Markdown job sections. Operators can edit
task strings; identities, repositories and SHAs must still match durable
receipts in `state.json`. Every successful read records an ordered, hash-only
replacement hunk in `read-diffs.jsonl` before any task is returned, including
unchanged reads and malformed edits within the size bound. No task/model/diff
text or environment is written to metadata or audit logs. Invalid or unreadable
state fails closed. Queue reads and mutations share the existing process lock;
atomic writes and write-ahead receipts recover an interrupted queue write on
the next read/replay. Deleted outstanding entries are restored; use `complete`
to acknowledge work. Completed receipts are retained for deduplication.

The queue is bounded to 2 MiB and 10,000 lifetime PR receipts; capacity errors
require operator attention, not silent eviction. Missing audit/deduplication
state, unsupported pre-existing Markdown, and scope changes affecting retained
receipts require operator reconciliation. Do not reset sidecars to bypass a
refusal. Review isolation, sensitive-path checks, PAUSE, rate limits, CI/revert
halts and credentials remain the supervisor's independent gates.

## 2. Installing and running Phantom

```sh
npm install -g @ashlr/phantom
phm --version
phm doctor            # health check; exits 1 when any check fails
phm verse             # console at http://127.0.0.1:7777/verse/
```

- `phm verse [--port N] [--no-open] [--json]` binds `127.0.0.1` only (default
  port 7777) and prints a read token and a mutation token. Keep both private.
  `--json` prints them too, so do not log that output.
- `phm doctor [--json] [--fix]` checks Node, git, config, Phantom Secrets, Locus,
  local providers and MCP registration, and prints a `fix:` line for each problem.
  A missing Locus or local model is a warning, not a failure. The MCP fix lines
  name `phm mcp install claude` and `phm mcp ecosystem --write`.
- `phm init [--wire] [--yes] [--json]` is idempotent onboarding. It writes the
  config, creates `~/.ashlr/genome`, symlinks `ashlr` into `~/.local/bin`, and
  with `--wire` registers the MCP gateway in detected editors. `phm init --help`
  prints help and writes nothing. With `--json`, the `ready` field matches the
  exit code. A new `config.json` carries only generic defaults (one tidy keeper,
  `github`); an existing one keeps its saved keepers and categories. Its roots
  are `~/Desktop/github` and `~/Desktop` when those exist, otherwise whichever
  of `~/code`, `~/src`, `~/projects`, `~/dev`, `~/Developer` and `~/repos`
  exist, and there are no tidy rules without a `~/Desktop`.
- `phm status [--json]` is the attention board (dirty, off-sync and stale
  repos). `--json` prints one object (`schemaVersion: 1`) with no ANSI.
- `phm preflight [--json]` is a read-only readiness check (exit 0 ready, 1 blocked).
- `phm onboard [--yes] [--json]` walks through the first safe activation (preflight, enroll
  one repo, dry-run plan, inbox). `--json` never prompts and prints one object.
  `phm onboard --rollback <repo> [--kill]` undoes it.
- `phm setup` and `phm worker setup` are currently unavailable and refuse
  before changing anything. `phm setup` first lists what to run instead
  (`phm init`, `phm doctor`, `phm verse`, `phm run "<goal>"`). Off macOS,
  `phm authority setup` exits 1 and changes nothing; its `--dry-run` and
  `--help` still run.
- `phm update [--check] [--json]` self-updates (`--check` is read-only);
  `phm upgrade` runs the same command.
- `phm docs --agent [--json]` prints the command registry for agents. `phm docs
  --json` without `--agent` prints a JSON usage error and exits 2.

**Output for agents.** `--help` and `-h` print usage and exit 0 without acting,
including on commands that mutate (`fleet pause`, `worker setup`, `roadmap run`,
`gh pr create`, `swarm approve`). Set `NO_COLOR` to any non-empty value to drop
ANSI codes from human output. Commands that take `--json` print one JSON object
on stdout; `enroll add --json` and `authority stop --json` send their prose to
stderr.

For the desktop app and the first useful turn, follow the
[Quickstart](QUICKSTART.md) and [desktop/README.md](../desktop/README.md).

### MCP server

`phm mcp` runs the MCP aggregation gateway on stdio. Its subcommands are `list`,
`doctor` (exit 1 when a required server is down), `install <claude|ashlrcode>`
and `ecosystem [--write] [--json]`.

`phm wire [claude|codex|cursor|all] [--config <path>] [--json]` registers the
gateway as server `ashlr-hub` with command `ashlr` and args `["mcp"]`. It backs
up the target config first and is idempotent.

`phm mcp install claude` also writes `~/.claude.json`, under the same
`ashlr-hub` key (with an absolute path to this package's `bin/ashlr`), so
running both commands leaves one gateway entry. Each of them also removes a
legacy `ashlr` entry when it launches this product's own gateway, and refuses
to overwrite an `ashlr-hub` entry that is not the gateway. Releases up to
3.29.15 register `phm mcp install claude` as a second server, `ashlr`; with one
of those, use one registration command, or delete one of the two entries from
`mcpServers` if the agent sees every gateway tool twice. `phm mcp install
ashlrcode` still writes the `ashlr` key.

| Client | Default config | How `wire` writes it |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | JSON merge into `mcpServers` |
| Codex | `~/.codex/config.toml` | runs `codex mcp add ashlr-hub -- ashlr mcp` |
| Cursor | `~/.cursor/mcp.json` | JSON merge into `mcpServers` |

Without a target, or with `all`, it wires only the editors it detects. An
editor counts as detected when its config exists (`~/.claude` or
`~/.claude.json`, `~/.codex`, `~/.cursor`) or its CLI (`claude`, `codex`,
`cursor`) is on `PATH`, so a fresh Claude Code install is found before its
first run. `phm init --wire` and `phm doctor --fix` use the same
detection. To test
without touching real configs, pass one explicit target with `--config`, for
example `phm wire claude --config /tmp/x/.claude.json` or
`phm wire codex --config /tmp/x/config.toml` (Codex still needs the `codex` CLI).
`phm wire --claude-md` prints a CLAUDE.md snippet and writes nothing.

`phm wire status [claude|codex|cursor|all] [--config <path>] [--json]` is read-only: for each client it reports the config path, whether the client is detected, whether the `ashlr-hub` entry is registered, whether it matches what `wire` writes, and whether a `<config>.bak` exists. It reports all three clients unless one is named, never writes or creates files, never runs a vendor CLI (Codex is read from `config.toml`), and never prints entry env values. Exit code 1 means a config could not be read or parsed.

`phm wire status gemini` (also included in the default all-client report) reads Gemini CLI's `mcpServers` object from `~/.gemini/settings.json` ([source](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)). Gemini is status-only for now: `phm wire gemini` refuses and changes nothing, and `phm wire` with no target never includes it. A write path will be dry-run by default with a backup.

The Codex check matches `[mcp_servers.ashlr-hub]` in `config.toml` with line-based regexes, not a TOML parser. An entry that uses multi-line `args` or an inline table is reported as `wired, entry differs` even if it is equivalent; re-run `phm wire codex` or inspect it with `codex mcp get ashlr-hub --json`.

### Daemon

`phm daemon status|doctor|pause|resume|stop|service-status`. In this build,
`daemon start --once` refuses before taking any action because the compiled
daemon trust roots are empty. `daemon start --once --dry-run` only plans, and
`daemon install` is withheld. `phm authority resident start|stop|status` manages
the resident daemon under an active grant. See
[RESIDENT-RUNTIME.md](RESIDENT-RUNTIME.md).

### Where state lives

Everything is under `~/.ashlr/`. Verified paths:

| Path | Contents |
| --- | --- |
| `config.json` | configuration (`phm config path`, `phm config effective --json`) |
| `KILL` | the global kill switch / Stop marker |
| `account-connections/connections.json` | native account roster that Phantom seats come from |
| `authority/ledger.jsonl` | hash-chained authority ledger |
| `manager/<ts>.json` | `phm manager` reports |
| `logs/` | supervised local-runtime stdout and stderr |
| `daemon.launchd.out.log`, `daemon.launchd.err.log` (macOS), `daemon.systemd.log` (Linux) | daemon service output |
| `fleet/mirrors/` | the fleet's own mirror clones (`phm mirror`) |

[RELIABILITY.md](RELIABILITY.md#where-state-lives) lists the rest
(`enrollment.json`, `daemon.json`, `inbox/`, `sandboxes/`, `audit/`).

## 3. Operating

| Group | Purpose (from `phm help`) |
| --- | --- |
| `phm sweep report [--repo <dir>]` | Weekly, local deletion review report; see [DELETION-SWEEP.md](https://github.com/ashlrai/phantom/blob/master/docs/DELETION-SWEEP.md) |
| `phm orient [--repo <r>] [--json]` | Read-only session-start context: memory hits, health, backlog, pending proposals |
| `phm enroll list\|add\|remove\|kill` | Repos open to autonomous work, plus the global kill switch (`enroll add <repo> --json` never prompts) |
| `phm backlog [refresh]` | Scored work queue across enrolled repos |
| `phm inbox [show\|approve\|submit\|reject] <id>` | Approval gate for proposals; `approve` applies to a local branch, `submit` hands off to a protected PR and never merges main |
| `phm goals add\|plan\|advance\|status\|pause\|resume` | Objectives decomposed into milestones; `advance` runs a sandboxed, proposal-only swarm on an enrolled repo |
| `phm goal "<objective>" --project <repo>` | One owner-invoked plan plus one proposal-only advance on an enrolled repo (`--plan-only` plans without advancing and needs no repo) |
| `phm run "<goal>"` / `phm swarm "<goal>"` | Local agent run / contracts-first multi-agent run (`run --engine <id>`; both accept `--allow-cloud`) |
| `phm fleet status\|watch\|direction\|doctor\|scorecard\|oversight` | Read-only fleet snapshot, direction report, engine readiness and quality metrics |
| `phm manager [--apply-rejects]` | Judges pending proposals; shadow mode by default, never merges |
| `phm leader show\|run\|tick\|say\|thread\|approve\|veto\|directives` | The Leader: memos, actions, directives and veto ([LEADER.md](LEADER.md)) |
| `phm improve propose [--open-pr --repo <dir>]` | Evidence-backed self-improvement proposals; `--open-pr` opens draft PRs from an isolated worktree and never merges or deploys |
| `phm cloud ...` / `phm devin ...` | Claude Code cloud and Devin lanes ([CLOUD.md](CLOUD.md), [DEVIN.md](DEVIN.md)) |
| `phm automations ...` | Turn triggers (labels, red CI, schedules, webhooks) into fleet tasks |
| `phm website status\|auto\|pause\|off` | Inspect or pause automatic phm.dev publication |
| `phm resources [--json]`, `phm usage` | Per-backend capacity and usage, read-only |
| `phm audit [N] [--json]` | Tail the append-only audit trail |

### Stop and pause

| Control | Effect |
| --- | --- |
| `phm authority stop [--no-wait] [--json]` / `clear-stop` | Engages Stop (`~/.ashlr/KILL`): halts running agents and cancels armed merges. With `--json`, stdout carries only the JSON result. Clearing is written to the ledger first. |
| `phm authority revoke [--reason <text>]` | Stop, set autonomy off, and require a new signed grant to resume |
| `phm authority switch off\|propose\|autonomous` | Lowers autonomy at once; can raise it only as far as the grant allows |
| `phm fleet pause` / `phm fleet resume` | Engage or release the global kill switch (idempotent) |
| `phm enroll kill on\|off` | Same global kill switch |
| `phm daemon pause` / `resume` | Halt autonomous dispatch only |
| `phm daemon stop` | Orderly shutdown; also sets the global kill switch |
| `phm website pause` | Pause automatic site publication |

### Per-agent Auto-merge

Agents started from the Agents board in the Phantom app can Auto-fix CI and
Auto-merge their PR. Both are off for each agent until the operator turns them
on. Auto-merge also needs `ASHLR_VERSE_AUTOMERGE_CHECKS` set to the exact,
comma-separated names of the required code checks; an unset or malformed value
holds every automatic merge. The gates run in this order, and the first refusal
is shown on the agent (`src/core/verse/agents/checks.ts`):

1. Auto-merge is on for this agent.
2. Stop (`~/.ashlr/KILL`) and pause (daemon or comms) are both clear.
3. The PR is open, not a draft, mergeable, and green on the head the checks
   ran on.
4. Git's own diff from the merge base to that head is readable, not empty,
   does not weaken tests (deleted tests, removed `it(` or `expect(`, added
   `.skip` or `.only`), and touches no protected path: CI, manifests,
   lockfiles, CODEOWNERS, hooks and, in Phantom itself, its Tier-1 authority
   code.
5. In Phantom's own repository, the standing grant's self-land policy is
   `merge-non-authority`. The repository is recognised by package name
   (`@ashlr/phantom` or `@ashlr/hub`) or by an `ashlrai/phantom` or
   `ashlrai/ashlr-hub` origin.
6. GitHub's branch protection. The squash merge is pinned to the head commit
   and never uses `--admin` or `--auto`.

The merge runs under the machine-wide outward-mutation fence, and Stop and
pause are read again inside it, so Stop or unenroll cannot report quiescence
while a merge is in flight. A busy fence holds the merge for a later pass.

Seats are not allowed to merge on their own. A seat's terminal asks the
operator before `gh pr merge`, a `gh api` merge or auto-merge call, or
`gh pr review --approve` (rule `gh-merge`). When Auto-fix sends failing CI log
tails back to the seat, they arrive fenced and labelled as untrusted data.

### Authority

`phm authority status [--json]` shows grant state, the switch, Stop, the
rollout stage, the ledger chain and custody. Grants (`authority grant`,
`re-approve`) are signed with Touch ID through custody and verify only against
the standing-grant trust roots compiled into the release
(`src/core/authority/trust-roots.ts`). The separate daemon and conductor
activation trust roots are empty, so permit-based daemon and conductor
execution stays dormant. `phm authority setup --dry-run` previews
Phase 0. Agents do not sign grants. The policy reserved for the owner is in
[AGENTS.md](../AGENTS.md). Design and procedures:
[STANDING-AUTHORITY.md](STANDING-AUTHORITY.md) and [AUTHORITY.md](AUTHORITY.md).

### Offline router backlog planning

`phm backlog plan` (RQ-BACKLOG-GEN) proposes READY jobs from captured VISION
checklists, open issues and repository scanner findings. Invoke it after each
bridge queue refresh. Below three READY jobs per active slot it refills toward
five per slot; at or above three it emits nothing. Zero slots emits nothing.
Existing excess work is preserved. If sources run out, it emits the available
jobs and reports the remaining gap rather than inventing work.

```sh
phm backlog plan --config rq-config.json --input rq-sources.json \
  --queue router-queue.md --previous-queue previous-queue.md
```

The command is offline and read-only: no model, GitHub, subprocess, credential
access, queue writes or dispatch. The bridge supplies fresh source snapshots
and the active slot count, invokes the planner repeatedly, and applies output
under its own queue lock only if the current queue SHA-256 matches the `sha`
in the stderr `rq-plan` record. If the queue changed, replan. READY here means
available work data; it grants no execution, review or merge authority. The
supervisor still owns isolated review, exact-head checks, denylist/sensitive-path
checks, credential isolation, merge caps, PAUSE and post-merge stop controls.

Configuration is separate from untrusted queue/source data. Its allowlist must
contain exactly the bridge's seven approved `ashlrai/<repo>` identities. The
following names are illustrative; replace all seven with the approved list.
The command cannot discover or expand that authority:

```json
{
  "v": 1,
  "activeSlots": 2,
  "allowedRepos": [
    "ashlrai/repo-0", "ashlrai/repo-1", "ashlrai/repo-2", "ashlrai/repo-3",
    "ashlrai/repo-4", "ashlrai/repo-5", "ashlrai/repo-6"
  ]
}
```

Source snapshots have this shape (repositories may be an approved subset):

```json
{
  "v": 1,
  "repositories": [{
    "repo": "ashlrai/repo-0",
    "vision": "# VISION\n- [ ] Restore offline search",
    "issues": [{
      "number": 42, "state": "open", "title": "Fix search pagination",
      "body": "Reproduce duplicate results on the second page."
    }],
    "scans": [{
      "id": "search:test:pagination", "source": "test",
      "title": "Cover empty search pages", "detail": "Add a regression case.",
      "value": 4, "effort": 2
    }]
  }]
}
```

`vision`, `issues` and `scans` are required; use empty text/arrays for a known
empty source. Collectors must surface failed or incomplete discovery themselves,
never replace unknown evidence with empty arrays. VISION accepts explicit
unchecked `- [ ]`, `* [ ]` or `+ [ ]` tasks outside fenced code; narrative and
completed tasks do not generate jobs. Issues require a unique positive number,
`open`/`closed` state, title and body (empty body allowed); closed issues are
excluded. Scans accept the existing `WorkItem` fields shown above (extra fields
are ignored), with a unique ID, a backlog source and integer value/effort 1–5.
Ranking reuses portfolio value/effort and source weighting, with stable ID order
for ties. VISION uses value 5/effort 2 and goal weighting; issues use 3/2.

stdout contains **only new jobs as JSON Lines** with fields `v:1`, `id`, `repo`,
`status:"READY"`, `source` (`vision`, `issue`, `scan`), `sourceId`, `title` and
`prompt`. The queue uses that same row schema, with status one of `READY`,
`RUNNING`, `BLOCKED`, `DONE`, `FAILED`, `CANCELLED`; initialize it as an empty
file. Despite its `.md` name, `router-queue.md` contains JSON Lines, without
Markdown fences or headings. Escaped prompt newlines remain within one row.
All source/task text is untrusted model prompt data and must never enter shell
commands. The planner does not approve paths or interpret source instructions.

Stable IDs, source identities and normalized per-repo titles prevent duplicate
work, including against every terminal and in-progress queue status. Keep queue
history (or equivalent tombstones); removing history permits replay. Existing
READY capacity counts distinct source identities and titles rather than copied
rows with different IDs; the bridge owns stale-job reconciliation.
stderr is JSON Lines too: each successful queue read emits `rq-queue-read`,
with before/after hashes and added/removed/changed row identities, states and
hashes. Task and diff text never appear in audit logs. Supply `--previous-queue`
to compare against the last read; without it, the baseline is empty. A malformed
queue produces a rejection hash record and no work. Invalid UTF-8, oversized,
missing or symlinked files are refused. File reads are capped at 8 MiB, queue
rows at 20,000, slots at 1,000, and issues/scans at 1,000 each per repo. Titles
are capped at 240 characters, issue bodies/scan details at 16,000, VISION at
128,000, and queue prompts at 20,000.

Exit 0 means no refill needed or target reached; exit 1 means source exhaustion
with possibly usable partial rows; exit 2 means bad usage or invalid snapshots
and no rows. Bridge collectors and the supervisor are separate components;
this command does not install or activate either.

## 4. Native engines

There are two registries:

- **Phantom chat routing** (`ROUTABLE_ENGINES` in
  `src/core/verse/multimodel/advisor.ts`): `claude`, `codex`, `devin`, `grok`,
  `local`. Native seats (claude, codex, grok) come from
  `~/.ashlr/account-connections/connections.json`. Local seats are Ollama
  models: the base URL is `cfg.models.ollama`, otherwise the default. Devin
  chat seats are separate: a cloud seat, and a CLI seat that is listed when the
  `devin` binary is found.
- **Fleet and run engines** (`src/core/run/engine-registry.ts`). The fleet
  dispatches only to `cfg.foundry.allowedBackends`, which defaults to
  `["builtin"]`. `phm fleet init [--write]` prints or merges a starter `foundry`
  block ([FOUNDRY-CONFIG.md](FOUNDRY-CONFIG.md)). `phm fleet doctor [--json]`
  probes each allowed engine.

How `fleet doctor` decides readiness (`src/core/fleet/engine-readiness.ts`):

| Engine id | Kind | Detected by | Auth signal |
| --- | --- | --- | --- |
| `builtin` | built-in | always present | always ready |
| `claude` | CLI | `claude` on `PATH` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` set, or `~/.claude/credentials.json` exists |
| `codex` | CLI | `codex` on `PATH` | `codex login status` output |
| `grok-cli` | CLI | `grok` on `PATH` | not probed |
| `devin-cli` | CLI | `devin` on `PATH` | not probed by `fleet doctor` |
| `aw`, `ashlrcode` (`ac`), `hermes`, `opencode` | CLI | binary on `PATH` | not probed |
| `claude-api`, `grok`, `kimi`, `nim`, `meta-muse`, `openai-compat` | API | env key set (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `NVIDIA_NIM_API_KEY`, `MODEL_API_KEY`, `OPENAI_COMPAT_API_KEY`) | a set key counts as ready |
| `local-coder` (Ollama), `llama-server` | local API | loopback `/models` lists the configured model ID (`OLLAMA_BASE_URL`, `LLAMA_SERVER_BASE_URL`) | not applicable |

**Not verified by these probes:** that a credential is valid or unexpired, that
a model completes a request, quota or plan entitlement, and auth for any CLI
marked "not probed". A key that is present, or a `codex` that reports logged
in, can still fail at runtime. For per-account capacity, use
[RESOURCE-POOLS.md](RESOURCE-POOLS.md) and `phm resources`. For local models,
use [LOCAL-FLEET.md](LOCAL-FLEET.md), `phm models` and `phm local-runtime status`.

## 5. Troubleshooting

| Symptom | Command |
| --- | --- |
| Not sure what is wrong | `phm doctor` (then `phm doctor --fix` for safe fixes), `phm preflight` |
| `phm` not found after install | `phm doctor` checks `~/.local/bin` on `PATH`; from source run `./install.sh` |
| Agent does not see Phantom tools | `phm mcp doctor`, `phm mcp list`, then `phm wire <client>` |
| No local provider reachable | `phm models`, `phm models start`, `phm local-runtime status\|logs` |
| `phm run --engine claude --sandbox-engine` refuses with exit 2 | Run as a non-root user (Claude Code refuses unattended mode as root), or hand the task to `phm cloud launch "<task>"`. Inside a Claude Code cloud container the session's sign-in is not passed into the sandbox: export `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) first |
| `repo not enrolled for autonomous work` | `phm enroll add <repo>` |
| An engine is not ready | `phm fleet doctor` and its `fix:` line. For a Claude engine with no credential under the daemon, the line names this platform's way to set `CLAUDE_CODE_OAUTH_TOKEN` (`launchctl setenv`, `systemctl --user set-environment` or `setx`) |
| `phm resources profile prepare` refuses the executable | The error names the failed check. Install symlinks are refused by design: pass the real path the error prints. The file must be a regular, executable file that is not group- or world-writable, and the profile's parent must be an existing owned mode-0700 directory |
| `daemon status` reports a state issue | `phm daemon recover-state --dry-run --expected-sha256 <sha256>`, then `--execute --plan-id <uuid> --plan-sha256 <sha256> --authorize <plan-sha256>` to quarantine; resolve the quarantine with `phm daemon resolve-state --dry-run --quarantine-plan-id <uuid> --quarantine-receipt-sha256 <sha256>` (see `phm daemon <sub> --help`) |
| Daemon claims running but is not | `phm daemon doctor`, then `phm daemon doctor --clear-stale` |
| Goals stuck in progress with no proposal | `phm goals recover-stale --dry-run` |
| Leftover sandbox worktrees | `phm sandbox list`, `phm sandbox gc` |
| Log roots using too much disk | `phm steward disk` (dry run; `--apply` deletes expired or over-quota plain logs and gzip-archives cold Codex and Claude sessions to `~/.ashlr/archive`; files modified in the last 24 hours are untouched) |
| Ledger integrity questions | `phm authority ledger verify` |
| Safety invariants | `phm verify-safety` |
| Ledger-specific diagnosis | `phm fleet evidence doctor <source> [--json]` |
| Undo a first activation | `phm onboard --rollback <repo> [--kill]` |

For more failure modes and their recovery, see
[RELIABILITY.md](RELIABILITY.md#failure-modes--recovery).

## Per-pool budget ledger

`phm budget show --json` returns `{ "budgets": ... }`; fleet status includes the
same `budgets` projection. Its schema is `fleet.budgets.v1`. It is an advisory
observation ledger, with no dispatch or spending authority. Pools are
`codex-cmp`, `codex-personal`, `devin`, `claude`, `grok-build`, `local-omlx`, and
`grok-ultra`. Claude remains `held`; local oMLX reports capacity only.

```sh
phm budget add codex-cmp --bucket weeklyPct --remaining 0 --reset-at 2026-11-01T12:00:00Z --json
phm budget add codex-cmp --bucket credits --remaining 42 --json
phm budget add devin --bucket acus --remaining 12.5 --json
phm budget add local-omlx --bucket capacity --remaining 2 --json
phm budget add codex-cmp --source log --input ./quota.log --json
phm budget show --json
```

Manual is the default source. `--at` sets an observation's UTC ISO timestamp;
future readings are rejected. Manual readings override later automatic readings
in the same pool and bucket until their explicit reset. Without a reset, that
manual override persists until another manual reading. Record a new manual
reading to correct it. A reset makes an old balance unknown until a new reading
arrives; it never assumes a full refill. Weekly percentages and credit balances
are independent, including when the weekly allowance is exhausted.

Automatic imports accept `--source cli|log --input <file|->` (`-` is stdin).
The caller supplies the pool explicitly, so personal and company accounts cannot
be inferred from account identifiers. Input is limited to 1 MiB. Supported
labelled lines are `weekly remaining: 25% reset: 2026-11-01T12:00:00Z`,
`weekly used: 75%`, `credits remaining: 42`, `acus remaining: 12.5`, and
`capacity remaining: 2`, optionally prefixed with `rate-limit`. Codex native
`event_msg` / `token_count` JSONL rate-limit records are also supported: only
10080-minute windows, finite credit balances, and observation/reset times are
kept. Unknown output is ignored; an import with no recognized readings fails.
No provider CLI is launched, no authentication file is read, and no raw log,
transcript, account identifier, or credential is stored.

Records are immutable batches under `~/.ashlr/fleet/budgets/`. Concurrent
imports cannot overwrite each other's batches. Unreadable or malformed records
make the snapshot `unavailable`, with unknown balances. Bucket projections
include remaining amount, source, timestamp, reset, last-two and trailing-12-hour
burn per hour, and projected exhaustion. Rates use observations in the current
uninterrupted window; refills and resets break the series. The 12-hour rate uses
the earliest available reading within that interval, so it can cover less than
12 hours. Projection uses the last-two rate from the observation timestamp and
is unknown if exhaustion would occur after reset. Capacity has no burn estimate.

The router queue's external `fleet.v1` and `dispatchd/status.json` producers are
not present in this repository. Their consumer contract is to embed the same
`budgets` object from `phm budget show --json`; this change does not create or
replace those external files. The core reader is `readPoolBudgets` in
`src/core/fleet/pool-budget-store.ts`.
