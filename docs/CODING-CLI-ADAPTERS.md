# Coding CLI adapters

Phantom already routes seats by headroom and reset timing (`src/core/routing/router.ts`) and already spawns Claude Code and Codex as fleet engines. This note covers the subscription CLI adapters that sit next to those API-key and local-model providers, and the `worker` plan that opens draft PRs from labelled issues.

The model names below are the owner inventory from 2026-10-25. They live in `config/coding-cli-models.json`. A name is eligible for a `--model` flag only after a minimal exec probe marks it `accepted`. A CLI cache listing is not account proof: `gpt-6.1-sol` and `gpt-5.5` were rejected on the ChatGPT account even when the cache listed the first of those.

## Adapters

| Id | Billing | How it runs | Headless edit |
| --- | --- | --- | --- |
| codex | subscription | `codex exec` | yes |
| claude | subscription | `claude -p` | yes |
| grok | metered (`XAI_API_KEY` until a subscription login is confirmed) | `grok` | yes, only when metered work is explicitly enabled |
| devin | metered | API, key name `DEVIN_API_KEY` via a secret lookup | stubbed |
| cursor | subscription | cloud agent binary | stubbed |
| ollama | local | installed tags on this machine | stubbed (the existing local-coder loop remains the editor) |
| lmstudio, mlx | local | not installed on the inventoried Mac | off |

Availability is a `--version` check plus a status command (`codex login status`, `claude auth status`, `grok models`). Those probes do not send a prompt. Model verification is a separate one-line exec. Rate-limit lines cool the backend down until the reported reset. A limit with no reset stays cooled down. Each adapter has a concurrency cap in the catalog (default 1).

Grok's status line `You are using XAI_API_KEY` classifies that backend as metered. Metered backends stay out of the plan until `--enable-metered` (the catalog default is off).

## Policy

Label pins:

- `route:codex`, `route:claude`, `route:grok` select that adapter when billing, cooldown and the concurrency cap allow it.
- `route:any` is reserved for the existing seat router (headroom, then reset spend-down, then in-flight spread). This slice does not pick a backend for that label.

Named models stay off the argv until `accountStatus` is `accepted`. The Codex default (no model flag) is the path the inventory showed working.

## Invariants

- Adapter environments are an allowlist: `PATH`, `HOME`, the CLI config dirs, and locale. Names matching a token, key, secret or `GH_TOKEN` are dropped, including `CLAUDE_CODE_OAUTH_TOKEN`. The CLI uses its own on-disk login.
- `roleAllowed` refuses `merge` and `credential` for `subscription`, `metered`, `local` and `loopback`. Produce and review stay allowed. `evaluateMergeAuthority` and the auto-merge path consult the same refusal when a proposal carries `billingClass`. Proposals with no billing class keep the historical frontier gate, so existing fleet tests stay put. Worker plans always set the class and only assign `produce`.
- The worker asks for `gh pr create --draft` only. The command list has no merge flag.
- Devin's secret lookup returns a value the log never prints. This slice does not call the Devin API.

## Gaps

- `worker drain` refuses to execute. `worker --dry-run` and `worker plan` print the plan.
- `route:any` does not yet call the seat router. The classifier (Jev, with a deterministic fallback), escalation and the learning ledger are the following slices.
- Cursor cloud dispatch, Devin API dispatch and the Ollama edit loop are declared so the catalog can rank them later. They do not spawn.
- Claude login on the inventoried Mac was expired, so Claude aliases `fable`, `opus` and `sonnet` stay `unverified`.
- The probe runner in production is `spawnCli`. Tests point it at fake binaries and fixture stdout. They do not call the real CLIs or the network.
