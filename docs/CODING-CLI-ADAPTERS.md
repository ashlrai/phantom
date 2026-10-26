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

- `route:codex`, `route:claude`, `route:grok` select that adapter when billing, cooldown and the concurrency cap allow it. Codex has two accounts (`codex-primary` uses `CODEX_HOME` when set, `codex-secondary` requires `CODEX_HOME_ALT`). The account with more remaining quota is chosen. A rate-limit or quota error fails over to the other account.
- `route:any` asks Jev for a job shape (complexity, risk, context, latency) and falls back to a length-and-keyword heuristic when Jev is unavailable. Risk cannot be lowered below the heuristic. The shape sets a tier floor.

Spend order, in `src/core/resources/pool-spend.ts`, extends the existing budget rather than a second balancer:

1. Credits with a known future expiry, soonest first.
2. Credits whose balance or expiry is unknown. Unknown is spendable, with a soft cap of one use per day.
3. Subscriptions that still have a window, spread by headroom inside the existing seat router.
4. Local models when the tier floor allows that quality.
5. Metered APIs last, and only when explicitly enabled. Devin is the exception: it turns on when `DEVIN_API_KEY` is a `cog_` key and the org id is present.

`phm resources figures` prints each pool, including which ones still need a live balance or expiry. The cloud credit total and the Devin ACU allotment are seeded from the existing budget defaults and labelled as estimates, not live balances.

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
- Lint failure escalates through the existing cascade, and the worker does not re-run the attempt until drain is wired. The learning ledger is the next slice.
- Claude login on the inventoried Mac was expired, so Claude aliases `fable`, `opus` and `sonnet` stay `unverified`.
- The probe runner in production is `spawnCli`. Tests point it at fake binaries and fixture stdout. They do not call the real CLIs or the network.
