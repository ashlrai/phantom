# Governed-client gateway opt-in: design note

Status: decisions recorded 2026-10-19 02:15 ET (Engineering Orchestrator, under Mason's delegation; see section 8). Slice A, the pure validator and config types, is #879: not wired into any client, defaults unchanged. Slice B (client wiring) is not started and will be left for Mason's review. Grant origin binding comes later in its own PR for Mason. Source: read of phantom master (332af868 era) plus `/workspace/phantom-work/base-url-audit-phantom.md`. No behavior was run against any gateway, and no claim is made about any particular gateway product.

## 1. Goal and non-goals
Let the two governed first-party clients talk to a gateway (LiteLLM, a corporate proxy, a local loopback shim) only when the operator explicitly opts in through config.

Governed clients:
- `src/core/run/anthropic-client.ts`: `ENDPOINT = https://api.anthropic.com/v1/messages`, fetched with `redirect: 'error'`, `x-api-key` header, claude-api grant, fixed `PRICES` table, `maxOutputTokens` limit required, response shape strictly parsed.
- `src/core/openai-agents/client.ts`: `ORIGIN = https://api.openai.com`, read-only GET client, `redirect: 'error'`, Bearer key, response must not echo the key.

Non-goals: no env var reads (ANTHROPIC_BASE_URL, OPENAI_BASE_URL are never read by these clients), no change to defaults, no change to usage endpoints (`src/core/fabric/usage-api.ts`, `src/core/observability/limits.ts` stay first-party constants), no change to `engine-registry.ts` (it already has per-engine `baseUrlEnv` for the compat engines), no new auth scheme.

## 2. Invariants (must hold exactly as for first-party)
1. Default config produces byte-identical requests to today (same URL, headers, body).
2. Environment never selects a target. The only input is the validated config value.
3. Grant admission (`cloudSubjectPermitted('provider', ...)`, `allowedBackends` includes `claude-api`, credential digest binding, fresh proof) runs before any contact, unchanged.
4. Output caps (`maxOutputTokens`, `MAX_GOVERNED_OUTPUT_TOKENS`) and the `PRICES` table apply unchanged. Unknown model still refuses `pricing-unknown`. A gateway cannot introduce models or prices.
5. The API key is attached only to a request whose URL passed validation, goes only to that configured target, and is never logged, never put in errors, never echoed (existing closed-diagnostics rule).
6. Usage and limits endpoints stay first-party and never use the gateway.
7. Response validation stays strict. A gateway that rewrites the response (extra usage fields, cache tokens, other service tier) fails closed, the same as today. This is deliberate: billing exposure stays derived from the pinned table, not from gateway claims.

## 3. Config shape (decided: top-level `gateways`)
Under the existing config object, a new optional block. Absent means today's behavior.

```jsonc
{
  "gateways": {
    "anthropic": {
      "enabled": true,                       // must be literally true; absent or false = first-party
      "baseUrl": "https://llm-gw.example.com/anthropic",  // origin plus optional path prefix; no query, no fragment
      "allowedHosts": ["llm-gw.example.com:443"]  // required for non-loopback; exact host:port, port required, no wildcards
    },
    "openaiAgents": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:4000"      // loopback IP literal may use http; no allowlist needed
    }
  }
}
```

The final request URL is `baseUrl` (trailing slash trimmed) plus the fixed API path the client already uses (`/v1/messages`, `/v1/...` agents paths). Callers cannot supply a path.

Decided: top-level `gateways`, not nested under `foundry`. Types live in `src/core/config.ts` (`GatewaysConfig`, `GatewayEntryConfig`, `GATEWAY_CLIENT_IDS`), which is not code-owned. The block is absent by default. An entry with any key other than `enabled`, `baseUrl` and `allowedHosts` is refused, so there is no place for a CA or extra headers. An opted-in entry that fails validation refuses (fails closed) instead of falling back to first-party.

## 4. Validation rules
Implemented once in the pure module `src/core/run/gateway-target.ts` (#879), which returns either a frozen target (`origin`, `prefix`, `host`, `port`, `loopback`) or a closed refusal reason (no input echoed in the reason). It reads no environment variables and does no DNS.

- Parse with `new URL`. Reject on throw.
- Scheme: `https:` always allowed (subject to allowlist). `http:` allowed only for loopback. Everything else refused (`ftp`, `file`, `data`, `ws`...).
- No userinfo: refuse if `username` or `password` is non-empty (keys must not ride in the URL).
- No query and no fragment. Path prefix normalized, must not contain `..`, `//`, backslash, `%2e`/`%2f` encodings, or control characters.
- Host handling: lowercase, then require the host as written to already be canonical (what `new URL` would produce). Trailing dots, numeric IPv4 shorthands (`127.1`, decimal, hex), expanded IPv6, percent-encoding and non-ASCII hosts are refused rather than silently rewritten. Exact string match against `allowedHosts`. No wildcard, no suffix match, no IP literal unless it is loopback.
- Port (decided): the allowlist is exact `host:port`, and each entry must name its port. The target's effective port (the scheme default when omitted, so `https://gw.example.com` is `gw.example.com:443`) must match an entry.
- Loopback definition (decided): the IP literals `127.0.0.1` and `[::1]` only. The name `localhost` and `*.localhost` are refused, because the OS resolves them and a hostile hosts file could rebind them. Other `127.0.0.0/8` addresses, `0.0.0.0`, link-local, RFC1918 and other IP literals are refused. Loopback is allowed without an allowlist entry but still needs `enabled: true`.
- Redirects: keep `redirect: 'error'` on every gateway request (any 3xx fails closed; nothing is followed, so the key can never move off-target). Keep the existing `response.redirected` check. Reject a gateway answering with a different final URL.
- TLS: https uses the normal system trust store. No `rejectUnauthorized` override. Custom CA is out of scope (decided).
- Revalidate on every request, not just at build time, and re-check that the validated config object is the frozen one the client was built with.
- Header handling: the key header is set only after validation succeeds. Gateway-specific extra headers are out of scope (decided; no config for them).
- Proxy env (`HTTPS_PROXY`) behavior is unchanged and out of scope; call it out in docs.

## 5. Tests (tests-first list)
New file `test/gateway-target.test.ts` (new file, not matched by any CODEOWNERS pattern seen):
- default (no block, `enabled` false or absent, `enabled: "true"` string) returns first-party target.
- env ANTHROPIC_BASE_URL and OPENAI_BASE_URL set to hostile values change nothing.
- accepts: `https://listed.example/x` with `listed.example:443` listed, `http://127.0.0.1:4000`, `http://[::1]:4000`.
- refuses `http://localhost:4000` and `*.localhost` (loopback by IP literal only).
- refuses: http to non-loopback, https host not listed, host differing by case-only trick is normalized (accept) but suffix or prefix lookalikes (`listed.example.evil.com`, `evil-listed.example`) refused, userinfo, query, fragment, `..` and encoded dot segments, backslash, `0.0.0.0`, `10.0.0.1`, `169.254.169.254`, `127.0.0.1.evil.com`, empty and non-string values, unsupported scheme.
- refusal reasons never contain the input URL.

Client tests (extend existing; see section 6 for code-owned status):
- Anthropic: with gateway enabled, fetch is called with the gateway URL and `redirect: 'error'`; key header present only for that URL; a 302 fails closed; grant-denied and `pricing-unknown` refuse before any fetch; `maxOutputTokens` missing refuses; cost accounting uses `PRICES` for the model; response with extra usage fields fails closed; error text and thrown diagnostics never contain the key.
- OpenAI agents: same for URL, redirect, key never in the URL or in errors, response echoing the key still rejected.
- Usage endpoints: with gateway enabled, `usage-api` and `limits` still call first-party constants (spy on fetch URL).
- Regression: with the block absent, the exact URL, headers and body match a recorded snapshot.

## 6. Files touched and code-owned status
Checked against `.github/CODEOWNERS` on master.

| File | Change | Code-owned? |
|---|---|---|
| `docs/GOVERNED-GATEWAY-DESIGN.md` (this note, the draft PR) | new | No |
| `src/core/run/gateway-target.ts` | new validator | No |
| `src/core/run/anthropic-client.ts` | use validated target instead of `ENDPOINT` | No (not matched) |
| `src/core/openai-agents/client.ts` | use validated target instead of `ORIGIN` | No (not matched) |
| `src/core/config.ts` | config type and default (absent) | No |
| `test/gateway-target.test.ts` | new | No |
| `test/openai-agents-read.test.ts` | extend | No |
| `test/anthropic-messages-client.test.ts` | extend | **Yes** (explicit line) |
| `test/claude-api-grant.test.ts` | extend if grant-order assertions are added | **Yes** (explicit line) |
| `src/core/run/engine-registry.ts` | not touched | Yes, deliberately untouched |
| `src/core/fabric/usage-api.ts`, `src/core/observability/limits.ts` | not touched (a test only asserts they stay first-party) | No |

Consequence: any implementation PR that extends `test/anthropic-messages-client.test.ts` is code-owned and needs Mason's review. The implementation could avoid that by putting the Anthropic gateway tests in a new file, but the client files themselves are governance-critical, so Mason review is recommended regardless. Re-run `codeowned_guard.sh` on each PR, since CODEOWNERS may change. This docs-only PR touches only `docs/GOVERNED-GATEWAY-DESIGN.md`; verify with the guard before anything else happens to it.

## 7. Risks
- Key redirection: a wrong or hostile `baseUrl` sends the real API key to a third party. Mitigations: explicit opt-in, allowlist, no env, no redirects, no userinfo. Residual: a config file writable by an attacker can still opt in. Config trust is the boundary; document it.
- Billing: a gateway could bill differently, route to another model, or cache. The pinned `PRICES` table would then understate or misstate cost. Mitigation: strict response parsing rejects unfamiliar usage shape; Phantom's ledger is an estimate of first-party pricing, not a gateway invoice. State this in docs.
- Grant meaning: the claude-api grant is bound to a credential digest. With a gateway the key may be a gateway virtual key, which is a different credential. The binding still compares the digest of whatever key is resolved, but an operator could be confused. Needs a decision (section 8).
- Loopback shim abuse: any local process on the port can read the key. Loopback http is plaintext on the machine; accepted risk, documented.
- DNS rebinding: listed names still resolve through DNS; `localhost` by name is refused (section 4).
- Gateway rewriting content: Phantom cannot verify the model that answered. Provenance claims for gateway runs should say "via gateway".
- Scope creep: compat engines already have `OPENAI_COMPAT_BASE_URL` and `OLLAMA_BASE_URL`. This change must not become a second route to the same thing.

## 8. Decisions (2026-10-19 02:15 ET)
Recorded by the Engineering Orchestrator under Mason's delegation, conservative options throughout. Mason can still revise any of them in review.
1. Decided: yes, governed clients may use a gateway, but only through explicit config opt-in. The environment never selects one.
2. Decided: top-level `gateways`.
3. Decided: exact `host:port` allowlist, port required in every entry.
4. Decided: yes, record `via: gateway` with the host in ledger and audit events, never the key, the URL or the path prefix. Slice A ships the type and helper (`gatewayViaMarker`); recording it is slice B.
5. Decided: yes, bind the target origin into the claude-api admission digest, but later, in its own PR left for Mason, because grant code and its tests are code-owned.
6. Decided: loopback by IP literal only (`127.0.0.1`, `[::1]`). `localhost` by name is refused.
7. Decided: custom CA and extra headers are out of scope.
8. Decided: non-code-owned scaffolding may land now. Slice A is #879.

## 9. Slices
- Slice A, #879: `src/core/run/gateway-target.ts`, `gateways` types in `src/core/config.ts`, `test/gateway-target.test.ts`. Not wired into any client, defaults unchanged.
- Slice B, not started: wire `anthropic-client.ts` and `openai-agents/client.ts` to the validated target and record the `via: gateway` marker, with tests in new non-owned files. It will be opened for Mason's review and not merged by automation.
- Slice C, later: grant origin binding in the admission digest, a PR for Mason (code-owned).
