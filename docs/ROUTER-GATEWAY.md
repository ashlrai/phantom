# Router gateway

Provider-neutral [failover chains](ROUTING.md#failover-chains) are advisory and dispatcher-unwired.

See [Router catalog refresh](ROUTER-CATALOG.md) for model discovery and weekly review-only patches.

The router gateway lets any agent ask for a model completion and have Phantom
pick the seat. It runs the same seat router (`routeSeat`) the fleet uses, so a
call gets the same checks as fleet work: the standing grant, the budget mode,
your reserves, the headroom left in each window and the context fit. If the
chosen seat fails, the call moves to the next ranked seat.

There are two ways to complete, and both run the same code:

- a loopback endpoint that speaks the OpenAI chat API (`phm router serve`);
- one CLI call (`phm run --model auto "<prompt>"`).

`phm router pick` previews the same routing decision and calls no model.
Native MCP tools cannot reach a cloud model, so this change does not register
an MCP completion or preview tool.

Routing is set by one versioned file, `~/.ashlr/router/gateway.json`, which you
can edit and commit like any other config.

## What it never does

- It never listens on anything but `127.0.0.1`. The config has no host setting.
  Requests whose `Host` or `Origin` is not loopback get HTTP 403.
- It never holds provider credentials. Claude, Codex and Grok seats run through
  each lane's own CLI and keychain via the host's account-bound adapter. Local
  models must be on `127.0.0.1`; a remote Ollama host is ruled out.
- It never skips admission. A pinned `<lane>:<model>` still has to pass the
  grant and budget checks. A spent seat is refused, not used.
- It never runs while the kill switch (`~/.ashlr/KILL`) is on. Routing
  previews still work.
- It never prints its bearer token. The token lives in
  `~/.ashlr/router/token` (mode 0600); clients read the file.

## Quick start

```sh
phm router config --init --json
phm router models --json
phm router pick --model auto --json
phm run --model auto "Summarize what a loopback-only endpoint is in two sentences." --json
phm router serve
```

`phm router pick` shows which seats would be tried, in order, and why. It calls
no model and writes nothing.

## Model names

| Name | Meaning |
|---|---|
| `auto` | `routeSeat` ranks every lane listed in the config. |
| `<lane>:<model>` | One lane, one model. The lane is a seat id (`codex-personal`, `grok`) or an engine name (`claude`). Local models are `local:<tag>`, for example `local:qwen3:8b`. |
| an alias | A name from the config's `models` block, for example `fast`. |

`phm router models --json` lists every name the gateway accepts right now.

With `phm run`, a `--model` value only routes when it is `auto` or starts with
a gateway lane (`claude`, `codex`, `grok`, `local`, or a seat id such as
`codex-personal`). A plain Ollama tag such as `--model qwen3:8b` keeps its old
meaning and starts a local goal run.

## The config file

`phm router config --init` writes the defaults. Every key is optional except
`version`, and unknown keys are refused so a typo cannot widen routing.

```json
{
  "version": 1,
  "port": 18741,
  "defaults": { "task": "code", "difficulty": "medium" },
  "lanes": ["claude", "codex", "grok", "local"],
  "models": {
    "fast": { "route": "local:qwen3:8b", "task": "bulk", "difficulty": "low" },
    "careful": { "route": "auto", "task": "review", "difficulty": "high" }
  },
  "maxAttempts": 2,
  "timeoutMs": 600000,
  "maxConcurrent": 4
}
```

- `lanes`: which engines or seat ids `auto` may use. A pinned lane must also be
  listed here.
- `models`: aliases. `route` is `auto` or `<lane>:<model>`.
- `maxAttempts`: how many ranked seats to try before giving up (1 to 5).
- `timeoutMs`: the limit for one attempt.
- `maxConcurrent`: requests served at once; more get HTTP 429.

Pass `--config FILE` to any `phm router` verb or to `phm run --model` to use a
file kept in a repository instead.

## Who may use which seat

Gateway calls are worker turns. A Claude, Codex or Grok seat is a candidate only
when the standing grant enables it for the `producer` role and lists its engine.
Codex also needs a current subscription-only billing boundary. Local models
need no grant. The owner's reserves always apply, because the callers are
agents. Devin cloud sessions keep their own lane and are not routed here.

## Calling the endpoint

`phm router serve` prints the URL and the token file path. Any OpenAI-compatible
client works:

```sh
curl -s http://127.0.0.1:18741/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.ashlr/router/token)" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello."}]}'
```

The response is a normal `chat.completion`. `model` names the seat and model
that answered, and a `phantom` block adds the route, the router's reason and
each attempt. Token counts in `usage` are estimates (4 characters per token),
because not every lane CLI reports them; `phantom.usageEstimated` says so.

Supported:

- `GET /v1/models`
- `POST /v1/chat/completions` with text messages. `stream: true` returns the
  finished answer as one SSE chunk, then `[DONE]`.
- `GET /healthz`, with no token, for a liveness check.

Refused with HTTP 400: tool calls, image content, `n` other than 1. A routing
hold returns 503 and every seat failing returns 502, each with the reason.

A sample agent that calls the endpoint with no dependencies is in
[examples/router-gateway/agent.mjs](../examples/router-gateway/agent.mjs):

```sh
node examples/router-gateway/agent.mjs "List three risks of a shared API key."
```

## Output shapes

- `phm run --model … --json` returns `router.completion.v1`:
  `ok`, `text` or `reason`, `seatId`, `engine`, `model`, `route`, `decision`
  and `attempts`.
- `phm router pick --json` returns `router.plan.v1`: `ok`, `steps`, `ruledOut`,
  `decision` and `reason`.
- `phm router models --json` returns `router.models.v1`.
- `phm router serve --json` prints one `router.gateway.v1` line with `url`,
  `port`, `config` and `tokenFile`, then serves until stopped.

Exit codes for `phm run --model` and `phm router pick`: 0 success, 1 no route or
every seat failed, 2 bad request.

Each routing decision is appended to the shadow decision log with source
`gateway`, next to the daemon's and the Leader's.

## Model verification

`phm models verify` reports registry status, evidence age and the configured
choices in `$ASHLR_RUNS_DIR/models.json` (default `~/.ashlr-runs/models.json`).
JSON is the default; use `--text` for plain words. Unverified, retired or unknown
choices exit 1, as do unreadable sources. Evidence older than 14 days is flagged
for review; stale verified entries remain eligible. Output is sorted by ID/key.

The gateway uses only exact verified IDs from [the registry](model-registry.json).
Auto and offered pins skip unverified/retired models and try the next verified
model offered by the same seat, retaining admission checks and logging the reason.
No verified alternative means no call. A missing or invalid registry fails closed.
`phm models [--json]` lists every registry entry: provider, model ID, lanes
(empty means unknown), `verified`, source URL, verified-on date, and the
`unverified` and `stale` (verified over 30 days ago) flags. The desktop Models
panel shows the same rows from `GET /api/verse/fleet/control/models`.

`phm models check [--json] [--diff <file>]` is the one read-only answer to "can
the router use this name?". For every model in the registry or chosen in
`models.json` it reports provider, ID, lanes, source URL, the date it was last
confirmed and a state: `confirmed`, `stale` (confirmed more than 14 days ago,
still routable) or `unconfirmed` (no source; `routable` is `false`, the same
answer the gateway gives). The JSON is `models.check.v1` with `version: 1`; a
registry that cannot be read gives `registry: "unknown"` and no models. Exit 0
means nothing needs doing. `--diff` takes a provider release-notes page saved to
disk (the command never fetches) and lists `new`, `renamed` and `retired` IDs
for that provider as leads to confirm; it changes nothing. The Models pane shows
the same report from `GET /api/verse/fleet/control/models/check`.

The check also compares the registry with what provider docs confirm, when a
docs-watch job has written `$ASHLR_HOME/model-docs.json` as
`{"schema": "models.docs.v1", "version": 1, "records": [...]}`. Each record
has `provider`, `id`, `status` (`current`, `deprecated` or `retired`),
`source_url` (https on the provider's own doc site, or the row is dropped),
`seen_at` and an optional `replacement`. Nothing here fetches the list. Each
model then carries `docs`: `confirmed`, `deprecated` (with `replacement` when the
docs name one), `retired`, `unconfirmed` (the provider has records, this ID has
none) or `unknown` (no list, or none for that provider). `missing` lists current
docs models the registry lacks, and `summary` is the top line in plain words.
The gateway uses the same function: a verified model that the docs call
`retired` or do not name is skipped, and the next verified model on the lane is
used. A docs list can only take a model away. With no list, `docs` is `unknown`
and routing follows the registry alone.

`phm models radar [--json] [--from <folder>] [--fetch]` finds models the day
they ship. It reads saved release notes, one file per provider (`anthropic.md`,
`openai.md`, `xai.md`, `google.md`, `zai.md`, `qwen.md`, `devin.md`; `.txt` and
`.html` work too) from `--from`, or from `$ASHLR_HOME/model-radar` when no
folder is given. `--fetch` first saves today's official pages into that folder,
so a daily job runs one command: `phm models radar --fetch --json`. The report
is `models.radar.v1` with `version: 1`: `new_models`, `retired_models` and
`renamed`, each with `provider`, the `id` as the page writes it, the `line` it
came from and `confidence`, plus `unchanged_count` and a one-line `summary`
such as `2 new, 1 retired, 0 renamed`. Only an ID that fully matches the
provider's exact ID shape is `high`; a marketing name such as "Claude Opus 7"
is `low`. `patch` (`models.registry-patch.v1`, `applied: false`) holds the
high-confidence changes only, and nothing applies it. A proposed new model is
`unverified`, so the gateway keeps refusing it until
`phm models verify <id> --provider <name> --source <url>` confirms it. A
provider with no saved file, an empty one, or no recorded doc site is shown as
`unknown` or `empty`, never as unchanged. `fetch` lists each page `--fetch`
tried and whether it was saved (`null` when no fetch was asked for). Exit 0
means every provider was read, no page failed for a whole provider and no
high-confidence change is waiting.

To qualify a new model on release day, confirm its exact ID in official docs, then
run `phm models verify <id> --source <url>` (add `--provider <name>` for an ID that
is not listed yet, and `--lane <lane>` for each lane that can run it). The command
reads the page itself and refuses unless it is https on the provider's own doc
site and names the exact ID. It records the result for this machine in
`$ASHLR_HOME/model-registry.json`; the router reads that together with the shipped
list. A local record never revives a `retired` model or replaces newer shipped
evidence. To ship evidence to everyone, edit `docs/model-registry.json` in a PR:
`verified_source`, the UTC date as `verified_at`, `status` `verified`, and
optional `lanes`. Unresolved IDs stay `unverified` with null evidence. Mark
documented retirements `retired`. Discovery alone never promotes status.
This gate covers the gateway; legacy task routing and the advisory queue router
are separate paths and are not yet protected by it.
