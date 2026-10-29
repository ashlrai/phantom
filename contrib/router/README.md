# ashlr-router

A Mac launchd runner that claims labelled GitHub issues and opens one draft pull request per job. It does not merge, tag, or publish. The queue runs around the clock. There is no quiet-hours window.

The separate, uninstalled PR supervisor and its commissioning requirements are
documented in [SUPERVISOR.md](SUPERVISOR.md).

From a checkout of this branch:

```bash
bash contrib/router/install.sh
```

That copies the runner into `~/ashlr-router`, writes `~/Library/LaunchAgents/com.ashlr.router.plist` and `com.ashlr.router.keepalive.plist`, and loads both when `launchctl` exists. The queue agent runs every 5 minutes. The keepalive agent runs once a day at 09:15 local time. `bash contrib/router/uninstall.sh` removes both agents, `bin`, and `lib`, and leaves the ledger, state, repos, logs, and config.

If `DEVIN_ORG_ID` is set to an `org-...` id while installing, both plists receive that variable. The value is not printed. An invalid value is left out.

## Queue

Issues in the configured ashlrai repos use `route:codex`, `route:claude`, `route:grok`, `route:devin`, or `route:any`. The issue body is the task. A claim adds `route:claimed` and a comment. `route:any` asks `phantom route --json` when that command exists, then falls back to the spend order below.

`model:<name>` or `tier:frontier|workhorse|cheap` may appear on a label or a body line. A label wins. The default tier is `workhorse`.

## Spend order

For `route:any`, a living pool is used in this order:

1. Codex work, `CODEX_HOME=~/.codex`. This account is spent even when another account has more remaining quota. It has credits and a free reset. Its login cannot be redone.
2. Codex personal, `CODEX_HOME_ALT=~/.codex-2`. Used only when work is dead, cooled, or rate-limited.
3. Devin v3, while `ashlr devin status --json` says another session fits in the remaining ACUs. The org id is `DEVIN_ORG_ID`.
4. Grok, only when the installed `grok` CLI is a SuperGrok subscription login.
5. Claude, when `claude auth status` says it is logged in.

At most 2 jobs run at once, and at most 1 job per CLI. Codex failover stays inside that one job. A second Codex account does not take the other job slot.

## Codex accounts

| id | home | env | order |
| --- | --- | --- | --- |
| `work` | `~/.codex` | `CODEX_HOME` | 1, spent hard |
| `personal` | `~/.codex-2` | `CODEX_HOME_ALT` | 2 |

The active home is passed as `CODEX_HOME`. The personal home is also passed as `CODEX_HOME_ALT`. Neither value is a token.

On any auth or refresh failure the runner marks that pool `dead` in `state.json`, writes the same state on the ledger line, and fails over to the next living account. A dead pool is not retried until the pool state is edited by hand. A Codex home that is simply logged out is skipped with a `login needed` line and is not marked dead.

The runner never runs `codex logout`. It does not read, modify, or delete Codex auth files or their backups. Login is whatever `codex login status` prints.

An older config that still says `fragile` for `~/.codex` and `durable` for `~/.codex-2` is read as work first and personal second. `bash contrib/router/install.sh` does not replace an existing `~/ashlr-router/config.json`.

## Keepalive

`com.ashlr.router.keepalive` runs `ashlr-router keepalive` once a day. That is one read-only Codex call with `CODEX_HOME` set to `~/.codex`:

```text
codex exec --sandbox read-only --skip-git-repo-check --ephemeral "Reply with ok"
```

The log line is `keepalive success` or `keepalive failure`. The command output is discarded, so a token printed by the CLI is not written to the log. An auth failure marks the work pool dead and does not retry it.

## Devin

Devin is the third pool. The runner shells out to `ashlr devin status --json` and `ashlr devin launch` through `env -i`. That environment keeps `PATH`, `HOME`, `USER`, `LANG`, `TERM`, and `TMPDIR`, and adds only `DEVIN_API_KEY` and `DEVIN_ORG_ID` when they are already set. `GH_TOKEN`, `OPENAI_API_KEY`, `XAI_API_KEY`, and every other token or key are left out. The org on the status payload must equal `DEVIN_ORG_ID` (`org-` plus 1 to 120 letters, digits, `_`, or `-`).

A Devin launch delivers its own draft pull request. The runner claims the issue, records the launch, and does not open a second pull request. Status JSON is not copied into the log. The log says `devin ready` or `devin unavailable`.

## Grok subscription check

Grok is fourth, and only when the CLI is signed in with a subscription. The check is `grok models` in the clean environment, which does not receive `XAI_API_KEY`. The output is classified and then discarded:

- Text that says the CLI is using `XAI_API_KEY`, or tells you to set that variable, is `metered`.
- A plan name `SuperGrok`, `SuperGrok Heavy`, `SuperGrok Pro`, `SuperGrok Plus`, `SuperGrok Lite`, `GrokPro`, `XPremiumPlus`, `XPremium`, or `XBasic`, with no API-key line, is `subscription`.
- `not signed in` is `out`.

The log records only `grok auth subscription`, `grok auth metered`, `grok auth out`, `grok auth unknown`, or `grok auth missing`. A metered result is not invoked. The clean environment still strips every `*_KEY`, so a key-only login cannot spend.

## oMLX

The local backend is oMLX, an OpenAI-compatible MLX server on `127.0.0.1:8000`. It replaces Ollama. It is off by default and only eligible for `cheap` jobs when a configured model is already listed by `GET /v1/models`. The runner asks the server for a unified diff and applies it. It never downloads a model.

On a Mac:

```bash
bash contrib/router/omlx-mac.sh install
bash contrib/router/omlx-mac.sh health
bash contrib/router/omlx-mac.sh download mlx-community/Qwen3-8B-4bit
bash contrib/router/omlx-mac.sh --prune-ollama qwen3.8:27b-ctx64k --omlx-model mlx-community/Qwen3-8B-4bit
```

`install` is macOS only. It runs `brew install jundot/omlx/omlx`, then `omlx serve --host 127.0.0.1 --port 8000`, then the health check. The bind address is the flag, not the default in settings. `download` reads the model size and refuses when free disk minus that size would drop below 20 GB. An unknown size is also refused. `--prune-ollama` runs `ollama rm` only after the oMLX model is listed and a tiny completion returns.

## Lease

Each running job writes a heartbeat under `~/ashlr-router/locks/jobs/`. On every tick, a job with no heartbeat for longer than the timeout is requeued: `route:claimed` is removed and a comment is added. A dirty worktree is saved as `~/ashlr-router/ledger-<repo>-<issue>-<time>.patch` before `git worktree remove`. Removal is never forced.

## Pools

Pool rows use Phantom's credit-pool names: `kind` (`gifted-cloud`, `purchased-usage`, `subscription-allowance`), `unit`, `surface`, `source.adapter`, `expiresAt`, and `expiryKind`. The ledger mirror also stores `billing`, `quotaRemaining`, `role`, `order`, `spend`, and `dead`. A metered API is `billing: metered` and is not given a credit-pool kind. Devin is `billing: acu` with adapter `devin-acu`. That mirror is the runner's own record. It is not a Phantom `credit-pools.json` observation.

Codex subscription rows use adapter `codex-rate-limits`. A SuperGrok login uses adapter `grok-usage` and `billing: subscription`.

## Guardrails

No `*_TOKEN` or `*_KEY` variable is passed to a model CLI. Devin is the exception for `DEVIN_API_KEY` only, and only inside its clean environment. Pull requests are drafts. At most 2 jobs run at once, and at most `max_per_cli` jobs per CLI (the default is 1). Free disk under 20 GB, or battery power under 30 percent, skips a tick. A `PAUSE` file in the router home skips selection and skips each job launch. Lease recovery still runs.

The runner does not push to the base repository. A push there starts `on: push` workflows, and those workflows can see repository secrets. It records the worktree commit before the model runs. After the model's process group has exited, any other `HEAD` aborts the job and nothing is pushed. An empty base aborts as well. The router then checks uncommitted paths against the denylist and against `CODEOWNERS` from that base commit. If any path matches `.github/**`, `CODEOWNERS`, release or publish config (`.releaserc*`, `release*.yml`, publish scripts, or a `package.json` change that alters `publishConfig` or a publish or release script), or a path in that base `CODEOWNERS` list, the job stops. The refusal comment is a fixed sentence and, for a path refusal, the number of denied paths. The router makes the single commit, with hooks disabled, and pushes that exact SHA. The branch prefix `router/*` or `cursor/router-*` is checked as well.

When the path check passes, the runner pushes that SHA to the authenticated user's fork (`gh repo fork --clone=false`, then `git -c core.hooksPath=/dev/null push --no-verify <url> <sha>:refs/heads/<branch>`) and opens the draft with `--head <login>:<branch>`. If the fork login or the fork push fails, the job stops. It does not fall back to the base repository. The installer and the runner set `umask 077`.

Host verification is off. The draft pull request's CI is the test run. `verify.host` can turn on a local `npm test` and `npm run lint`, and that run uses a throwaway `HOME` and an allowlisted `PATH`. Ledger lines keep structured fields (`remaining`, `reset`, `pool`, `outcome`) and do not keep transcript text. Ledger lines are not copied to GitHub issue comments unless `ledger_mirror` is true, and then only those structured fields are posted. Weekly CLI auto-update is off. When `freshness.enabled` is true, Codex updates only to a release that is at least `min_age_days` old (default 3). It does not install `@latest`.

`ashlr-router status` prints jobs, accounts, pools, cooldowns, disk, battery, and the last 10 ledger lines. `ashlr-router dry-run` prints the plan and does not claim or run a model CLI.

## Commands the runner uses

Codex, with both homes:

```text
env -i PATH HOME USER LANG TERM TMPDIR CODEX_HOME=<active home> CODEX_HOME_ALT=<personal home> codex exec --sandbox workspace-write --cd "$WORKTREE" --ephemeral --json --output-last-message "$LAST" --model "$MODEL" -
```

Claude, flags before `-p`:

```text
env -i PATH HOME USER LANG TERM TMPDIR claude --permission-mode acceptEdits --output-format json --no-session-persistence --model "$MODEL" -p
```

Grok, only after the subscription check above:

```text
env -i PATH HOME USER LANG TERM TMPDIR grok --prompt-file "$PROMPT" --model "$MODEL" --permission-mode acceptEdits --sandbox workspace --output-format json --no-auto-update --cwd "$WORKTREE"
```

Devin, clean environment, only the Devin variables when they are already set:

```text
env -i PATH HOME USER LANG TERM TMPDIR DEVIN_API_KEY DEVIN_ORG_ID ashlr devin launch "<issue text>" --repo owner/name --title "<title>" --json
```

oMLX, loopback only:

```text
POST http://127.0.0.1:8000/v1/chat/completions
```

The model flag is omitted when the probe rejected the configured model. Codex probes with `codex exec --sandbox workspace-write --skip-git-repo-check --ephemeral --model "$MODEL" "Reply with ok"`.

## Known gaps

- A metered Grok login is detected and then skipped. There is no key exception and no `grok update`.
- Claude's recorded model list is the aliases `fable`, `opus`, and `sonnet`. `claude auth status` decides whether Claude is logged in.
- Codex can reject a catalog name, including `gpt-6.1-sol`. `gpt-6-astra` stays unverified until the exec probe accepts it. A runtime rejection retries once without `--model`.
- The work `~/.codex` pool stays dead after an auth failure until the pool state is edited by hand.
- Local oMLX applies a unified diff and never downloads. It is off by default. `omlx-mac.sh download` is a separate, disk-guarded step.
- `phantom route --json` is optional. An invalid pick falls back to the spend order. A returned `ollama` cli is treated as `omlx`.
- Host verification is off by default. Draft PR CI is the check. An opted-in local verify uses a throwaway HOME.
- `git worktree remove` is never forced. A dirty tree is left in place after its patch is saved.
- The launchd `PATH` is the install-time `PATH` plus the usual Homebrew and user bin directories.
- The lock is one Mac, not a multi-host lease. Rate-limit parsing is best effort.
- Ledger rows do not store CLI transcript lines. The keepalive log does not store command stdout.
- The draft body contains `Fixes #N`, so merging the draft would close the issue. A Devin launch can open its own draft as well.
- A Codex probe can touch files under that account's `CODEX_HOME` even with `--ephemeral`.
- `workspace-write` does not fully block network access. Claude `acceptEdits` is a permission mode, not an OS sandbox.
- Timeout exit 124 can collide with a CLI that exits 124.
- Auto-update is off unless `freshness.enabled` is true. A Codex update then pins a release at least 3 days old.

## Desktop friction queue

The console's **Flag UI friction** action appends a UTF-8 JSON object followed
by a newline to `~/.ashlr/router/feedback.jsonl`. The authenticated POST at
`/api/verse/feedback` requires the console mutation token and dispatch-enabled
server, like other console writes. It never starts a job or runs a shell.

Each v1 record has a unique `id`, ISO `createdAt`, fixed `repo: phantom`,
`tier: work`, `lead: Adoption`, `flag: agentWorkspace`,
`source: desktop-feedback`, plus `surface` and the user's `description`.
Descriptions are untrusted data, including any embedded instructions or shell
syntax. Consumers must parse JSONL and apply their normal admission controls;
never source the file or interpolate its contents into a command. Pool
selection and job execution belong to the router, not this writer.

`queue-writer.mjs` exports the same writer for local integrations after a build.
Its optional root argument is for trusted host configuration and tests only;
the HTTP endpoint never accepts a destination. Files are created private and
appended with symlink refusal. Success is returned after syncing the append.
