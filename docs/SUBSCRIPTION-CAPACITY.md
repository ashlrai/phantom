# Subscription capacity

Which subscriptions give the router included, non-metered capacity, so
contributors know which seats to connect. The router spends included seats
before anything metered; metered API rows stay opt-in and are never added to a
default route. The machine-readable table is `SUBSCRIPTION_CAPACITY` in
`src/core/routing/subscription-capacity.ts`. Unknown caps are `null`, never 0.

Google facts were checked on 2026-11-25 against
[Antigravity Workspace](https://antigravity.google/docs/workspace),
[Antigravity pricing](https://antigravity.google/pricing), the
[Gemini CLI docs](https://geminicli.com/docs/) quota page and the
[Gemini 4 Neon model page](https://aistudio.google.com/docs/models/gemini-4-neon).

## Provider table

| Provider | Product (lane) | Account kind | Plan | Cost | Models | Refresh | Daily cap | Weekly cap | Neon |
|---|---|---|---|---|---|---|---|---|---|
| Google | Antigravity (`agy`) | personal | Free | free | Gemini 4 Hydrogen, 3.8 Flash, Claude Sonnet/Opus 4.6, GPT-OSS-120b | weekly baseline | null | null | no |
| Google | Antigravity (`agy`) | personal | Google AI Pro | included | Free models plus Gemini 4 Neon, Carbon, Argon, Orchestrator, Claude Sonnet/Opus 5.5 | 5 h, weekly | null | null (higher than Free) | yes |
| Google | Antigravity (`agy`) | personal | Google AI Ultra | included | as Pro | 5 h, weekly | null | null (highest) | yes |
| Google | Antigravity (`agy`) | workspace | Workspace | included, `starter-quota` | unknown | unknown | null | null | no |
| Google | Antigravity (`agy`) | workspace | Gemini Enterprise | included | unknown | unknown | null | null | unknown |
| Google | Antigravity (`agy`) | cloud-project | Google Cloud | metered, opt-in | unknown | none | null | null | unknown |
| Google | Gemini CLI (`gemini`) | personal | Code Assist for individuals | free | unknown | daily | 1,000 requests | null | no |
| Google | Gemini CLI (`gemini`) | personal | Google AI Pro | included | unknown | daily | 1,500 requests | null | no |
| Google | Gemini CLI (`gemini`) | personal | Google AI Ultra | included | unknown | daily | 2,000 requests | null | no |
| Google | Gemini CLI (`gemini`) | workspace | Code Assist Standard | included | unknown | daily | 1,500 requests | null | no |
| Google | Gemini CLI (`gemini`) | workspace | Code Assist Enterprise | included | unknown | daily | 2,000 requests | null | no |
| Google | Gemini CLI (`gemini`) | api-key | unpaid key | free | unknown | daily | 250 requests | null | no |
| Google | Gemini API | api-key | free tier | free | no Neon | none | null | null | no |
| Google | Gemini API | api-key | paid tier | metered, opt-in ($3/$15 per 1M tokens for Neon) | Neon, Carbon, Hydrogen | none | null | null | yes |
| Anthropic | Claude Code (`claude`) | personal / workspace | Pro, Max / Team, Enterprise | included | unknown | weekly | null | null | no |
| OpenAI | Codex (`codex`) | personal / workspace | Plus, Pro / Business, Enterprise | included | unknown | 5 h, weekly | null | null | no |

Gemini CLI does not support `gemini-4-neon` yet
([google-gemini/gemini-cli#30385](https://github.com/google-gemini/gemini-cli/issues/30385)).
For included Neon, connect Antigravity on a personal Google account with
Google AI Pro or Ultra.

## Workspace accounts get a starter quota

Workspace plans include no Antigravity plan, higher rate limits or AI credits.
When the `agy` lane is signed into a Workspace account (other than Gemini
Enterprise seats), `phm route decide` labels its candidate `seat_label:
"starter-quota"` and ranks it after every other seat, so it runs only when no
other seat can take the job.

## Declare and read the active Google seat

The router cannot see which account a CLI is signed into, so the operator
declares it in `<runs>/queue/subscription-seats.json` (`ASHLR_RUNS_DIR`,
default `~/.ashlr-runs`). Keys are lanes; values hold `account_kind`
(`personal`, `workspace`, `cloud-project` or `api-key`) and `plan`. A malformed
lane entry is ignored, never guessed.

```json
{ "agy": { "account_kind": "workspace", "plan": "workspace" },
  "gemini": { "account_kind": "personal", "plan": "google-ai-pro" } }
```

`phm route seats --json` prints `route.subscription-capacity.v1`: each Google
seat with its plan, cost class, label, refresh windows and caps, the `active`
lane (the first non-metered seat without a `starter-quota` label, else the
starter seat) and `neon`, whether the active seat reaches Gemini 4 Neon on
included capacity (`null` when unknown). `metered_opt_in` is always `false`:
the readout never selects a metered seat. In the example above the active seat
is `gemini` and `neon` is `false`.
