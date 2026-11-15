# Router gateway

The router gateway lets any agent ask for a model completion and have Phantom
pick the seat. It runs the same seat router (`routeSeat`) the fleet uses, so a
call gets the same checks as fleet work: the standing grant, the budget mode,
your reserves, the headroom left in each window and the context fit. If the
chosen seat fails, the call moves to the next ranked seat.

There are three ways in, and all three run the same code:

- a loopback endpoint that speaks the OpenAI chat API (`phm router serve`);
- one CLI call (`phm run --model auto "<prompt>"`);
- one read-only MCP tool (`phm_router_plan`) on the Phantom MCP gateway
  (`phm mcp`) that previews the same routing decision.

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

## Calling from an MCP client

`phm_router_plan` takes `model` and optional `task`, `difficulty` and
`promptChars`, and returns the same `router.plan.v1` as `phm router pick`. It is
read-only: it calls no model and writes nothing, and it answers even with the
kill switch on. Native MCP tools never reach a cloud model (the M31 contract),
so an MCP client that wants the answer itself calls the loopback endpoint or
`phm run --model`. See [MCP tools](MCP-TOOLS.md).

## Output shapes

- `phm run --model … --json` returns `router.completion.v1`:
  `ok`, `text` or `reason`, `seatId`, `engine`, `model`, `route`, `decision`
  and `attempts`.
- `phm router pick --json` and `phm_router_plan` return `router.plan.v1`: `ok`, `steps`, `ruledOut`,
  `decision` and `reason`.
- `phm router models --json` returns `router.models.v1`.
- `phm router serve --json` prints one `router.gateway.v1` line with `url`,
  `port`, `config` and `tokenFile`, then serves until stopped.

Exit codes for `phm run --model` and `phm router pick`: 0 success, 1 no route or
every seat failed, 2 bad request.

Each routing decision is appended to the shadow decision log with source
`gateway`, next to the daemon's and the Leader's.
