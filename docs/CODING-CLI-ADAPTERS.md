# Coding CLI adapters

Phantom already routes seats by headroom and reset timing (`src/core/routing/router.ts`) and already spawns Claude Code and Codex as fleet engines. This note covers the subscription CLI adapters that sit next to those API-key and local-model providers, and the `worker` plan that opens draft PRs from labelled issues.

The model names below are the owner inventory from 2026-10-25. They live in `config/coding-cli-models.json`. A name is eligible for a `--model` flag only after a minimal exec probe marks it `accepted`. A CLI cache listing is not account proof: `gpt-6.1-sol` and `gpt-5.5` were rejected on the ChatGPT account even when the cache listed the first of those.

## Adapters

| Id | Billing | How it runs | Headless edit |
| --- | --- | --- | --- |
| codex | subscription | `codex exec` | yes |
| claude | subscription | `claude -p` | yes |
| grok | metered (`XAI_API_KEY` until a subscription login is confirmed) | `grok` | yes, only when metered work is explicitly enabled |
| devin | metered | API, key read only from `process.env.DEVIN_API_KEY` | stubbed |
| cursor | subscription | cloud agent binary | stubbed |
| omlx | loopback | OpenAI-compatible `http://127.0.0.1:8000/v1` | stubbed (default local tier) |
| ollama | local | installed tags on this machine | stubbed fallback when oMLX cannot serve |
| lmstudio, mlx | local | not installed on the inventoried Mac | off |

Availability is a `--version` check plus a status command (`codex login status`, `claude auth status`, `grok models`). Those probes do not send a prompt. Model verification is a separate one-line exec. Rate-limit lines cool the backend down until the reported reset. A limit with no reset stays cooled down. Each adapter has a concurrency cap in the catalog (default 1).

Grok's status line `You are using XAI_API_KEY` classifies that backend as metered. Metered backends stay out of the plan until `--enable-metered` (the catalog default is off).

## Policy

Label pins:

- `route:codex`, `route:claude`, `route:grok` select that adapter when billing, cooldown and the concurrency cap allow it. Codex spends `codex-primary` (`CODEX_HOME`, or `~/.codex` when that variable is unset) first. `codex-secondary` (`CODEX_HOME_ALT`, or `~/.codex-2`) is next. A missing home, an unreadable home, an auth or login error, or a rate limit marks that account dead in pool state and fails over. The primary is not retried. The worker never runs `codex logout`, and it only checks that `auth.json` exists. It does not read, modify, or delete that file or a backup.
- `route:any` asks Jev for a job shape (complexity, risk, context, latency) and falls back to a length-and-keyword heuristic when Jev is unavailable. Risk cannot be lowered below the heuristic. The shape sets a tier floor.

Spend order, in `src/core/resources/pool-spend.ts`, extends the existing budget rather than a second balancer:

1. Credits with a known future expiry, soonest first.
2. Credits whose balance or expiry is unknown. Unknown is spendable, with a soft cap of one use per day, except pools that are spent fully.
3. `codex-primary`, spent first even when another Codex account has more headroom.
4. `codex-secondary`.
5. Other subscriptions, such as Claude.
6. Devin, spending its ACUs fully. The per-day soft cap does not hold Devin back.
7. Grok when `grok models` reports a subscription login. That login is preferred over the metered `XAI_API_KEY` line.
8. Local models that meet the tier floor. oMLX comes before Ollama.
9. Metered APIs last, and only when explicitly enabled. A metered Grok login stays in this last group.

`phm resources figures` prints each pool. Where an API exists it reads the live number. Devin usage comes from `GET /v3/organizations/{org_id}/consumption/daily` through the existing client. That reading is usage, not a remaining balance, so the balance stays `unknown` when the API does not return one. A failed read stays `unknown`. The cloud credit total and the Devin ACU allotment are still printed as estimates, not as the live balance.

Named models stay off the argv until `accountStatus` is `accepted`. The Codex default (no model flag) is the path the inventory showed working.

Main merges stay frontier-only through the existing merge gate. Subscription, local, loopback and metered producers are still refused merge and credential roles.

## Invariants

- Adapter environments are an allowlist: `PATH`, `HOME`, the CLI config dirs, and locale. Names matching a token, key, secret or `GH_TOKEN` are dropped, including `CLAUDE_CODE_OAUTH_TOKEN`. The CLI uses its own on-disk login.
- `roleAllowed` refuses `merge` and `credential` for `subscription`, `metered`, `local` and `loopback`. Produce and review stay allowed. `evaluateMergeAuthority` and the auto-merge path consult the same refusal when a proposal carries `billingClass`. Proposals with no billing class keep the historical frontier gate, so existing fleet tests stay put. Worker plans always set the class and only assign `produce`.
- The worker asks for `gh pr create --draft` only. The command list has no merge flag.
- Devin's key is read only from `process.env.DEVIN_API_KEY`. The catalog secret name and `SecretLookup.get` are not consulted. The documented org id `org-c65eb6611a9c4a3697fa7e6630d101d6` is not a secret and is the catalog default. `DEVIN_ORG_ID` overrides it. The adapter is off when either value is missing. A session create is `POST /v3/organizations/{org_id}/sessions` through the existing Devin client. The key is not written into the plan, the command list, the result detail, or a log line.
- oMLX is the default local backend. Its base URL must be loopback (`127.0.0.1`, `localhost`, or `[::1]`). A remote URL is refused and is not requested. The probe is `GET /v1/models` with no API key. Ollama is the fallback when oMLX is off, unreachable as a loopback URL, or has no fitting model. Loopback and local backends still cannot merge or hold a credential role.

## Gaps

- `worker drain` refuses to execute. `worker --dry-run` and `worker plan` print the plan.
- The cloud credit pool is selected first, and this worker does not launch it. `phm cloud` remains the launcher. Cursor cloud dispatch and the Ollama edit loop are still stubbed.
- Lint failure escalates through the existing cascade, and the worker does not re-run the attempt until drain is wired.
- Spend decisions append to a JSONL ledger. Each `worker drain` reads that ledger, runs `reweight` from merge rate, CI pass rate, and cost per merged PR, and writes the weights to a local JSON file. That file is not role policy and drain still refuses to execute.
- `phm learn mine` reads the ledger, a local file of failed CI runs, and a local file of PR review comments. It writes candidate backlog items to a local JSON file. It creates no issues and no comments. `--publish` is refused and stays off.
- Claude login on the inventoried Mac was expired, so Claude aliases `fable`, `opus` and `sonnet` stay `unverified`.
- The probe runner in production is `spawnCli`. Tests point it at fake binaries and fixture stdout. They do not call the real CLIs or the network.
