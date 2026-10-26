# ashlr-router

A Mac launchd runner that claims labelled GitHub issues and opens one draft pull request per job. It does not merge, tag, or publish.

From a checkout of this branch:

```bash
bash contrib/router/install.sh
```

That copies the runner into `~/ashlr-router`, writes `~/Library/LaunchAgents/com.ashlr.router.plist`, and loads it when `launchctl` exists. The agent runs every 5 minutes. `bash contrib/router/uninstall.sh` removes the agent, `bin`, and `lib`, and leaves the ledger, state, repos, logs, and config.

## Queue

Issues in the configured ashlrai repos use `route:codex`, `route:claude`, `route:grok`, or `route:any`. The issue body is the task. A claim adds `route:claimed` and a comment. `route:any` asks `phantom route --json` when that command exists, then falls back to credit-pool order and ledger headroom.

`model:<name>` or `tier:frontier|workhorse|cheap` may appear on a label or a body line. A label wins. The default tier is `workhorse`.

## Codex accounts

Two homes are configured:

| id | home | role |
| --- | --- | --- |
| `durable` | `~/.codex-2` | Durable primary pool. Signed in. Preferred when headroom ties. |
| `fragile` | `~/.codex` | Still used while it works. The account cannot renew. |

Each account is its own concurrency slot, and the runner still allows at most 2 jobs at once and at most 1 job per account. `CODEX_HOME` is passed in the clean environment. It is not a token.

On a refresh or renewal failure the runner marks that pool `dead` in `state.json`, writes the same state on the ledger line, and fails over to the other living account (the durable pool, when the fragile one dies). A dead pool is not retried. A Codex home that is simply logged out is skipped with a `login needed` line and is not marked dead.

The runner never runs `codex logout`. It does not read, modify, or delete Codex auth files or their backups. Login is whatever `codex login status` prints.

## Lease

Each running job writes a heartbeat under `~/ashlr-router/locks/jobs/`. On every tick, a job with no heartbeat for longer than the timeout is requeued: `route:claimed` is removed and a comment is added. A dirty worktree is saved as `~/ashlr-router/ledger-<repo>-<issue>-<time>.patch` before `git worktree remove`. Removal is never forced.

## Pools

Pool rows use Phantom's credit-pool names: `kind` (`gifted-cloud`, `purchased-usage`, `subscription-allowance`), `unit`, `surface`, `source.adapter`, `expiresAt`, and `expiryKind`. The ledger mirror also stores `billing`, `quotaRemaining`, `durability`, `primary`, and `dead`. A metered API is `billing: metered` and is not given a credit-pool kind.

Spend order is expiring credits first (soonest `expiresAt`), then resetting subscriptions, then metered APIs. Grok is metered and disabled by default. Codex subscription rows use adapter `codex-rate-limits`.

## Guardrails

No `*_TOKEN` or `*_KEY` variable is passed to a model CLI. Pull requests are drafts. At most 2 jobs run at once. Free disk under 20 GB, or battery power under 30 percent, skips a tick. A `PAUSE` file in the router home skips new jobs. Lease recovery still runs.

`ashlr-router status` prints jobs, accounts, pools, cooldowns, disk, battery, and the last 10 ledger lines. `ashlr-router dry-run` prints the plan and does not claim or run a model CLI.

## Commands the runner uses

Codex, with the account home:

```text
env -i PATH HOME USER LANG TERM TMPDIR CODEX_HOME=<account home> codex exec --sandbox workspace-write --cd "$WORKTREE" --ephemeral --json --output-last-message "$LAST" --model "$MODEL" -
```

Claude, flags before `-p`:

```text
env -i PATH HOME USER LANG TERM TMPDIR claude --permission-mode acceptEdits --output-format json --no-session-persistence --model "$MODEL" -p
```

Grok is disabled by default. Its invocation, if enabled, is:

```text
env -i PATH HOME USER LANG TERM TMPDIR grok --prompt-file "$PROMPT" --model "$MODEL" --permission-mode acceptEdits --sandbox workspace --output-format json --no-auto-update --cwd "$WORKTREE"
```

Ollama is off by default and only eligible for `cheap` when a configured model is already installed:

```text
env -i PATH HOME USER LANG TERM TMPDIR OLLAMA_HOST=127.0.0.1:11434 ollama run "$MODEL" "$PROMPT"
```

The model flag is omitted when the probe rejected the configured model. Codex probes with `codex exec --sandbox workspace-write --skip-git-repo-check --ephemeral --model "$MODEL" "Reply with ok"`.

## Known gaps

- Grok is pay-per-token through `XAI_API_KEY`. The clean environment strips that variable, so Grok stays disabled. There is no key exception and no `grok update`.
- Claude's recorded model list is the aliases `fable`, `opus`, and `sonnet`. `claude auth status` decides whether Claude is logged in.
- Codex can reject a catalog name, including `gpt-6.1-sol`. `gpt-6-astra` stays unverified until the exec probe accepts it. A runtime rejection retries once without `--model`.
- The fragile `~/.codex` pool is used only until an auth or refresh failure. After that it stays dead until the pool state is edited by hand.
- Local Ollama applies a unified diff and never pulls. It is off by default.
- `phantom route --json` is optional. An invalid pick falls back to pool order and headroom.
- Verification runs `npm test` and `npm run lint` only when `package.json` and `node_modules` already exist, with `npm_config_offline=true`.
- `git worktree remove` is never forced. A dirty tree is left in place after its patch is saved.
- The launchd `PATH` is the install-time `PATH` plus the usual Homebrew and user bin directories.
- The lock is one Mac, not a multi-host lease. Rate-limit parsing is best effort.
- CLI stdout is stored in the ledger and can echo secrets if a tool prints them.
- The draft body contains `Fixes #N`, so merging the draft would close the issue.
- A Codex probe can touch files under that account's `CODEX_HOME` even with `--ephemeral`.
- `workspace-write` does not fully block network access. Claude `acceptEdits` is a permission mode, not an OS sandbox.
- Timeout exit 124 can collide with a CLI that exits 124.
- An empty recorded version is treated as older, so a weekly Codex update is attempted.
