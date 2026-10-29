# Nightly model capability cache

`RADAR-MODELCAPS` provides advisory Anthropic API metadata for routing and Claude
adapter options. It does not change merge authority, native seat admission,
pricing, CLI context budgets or model quality rankings. `elite-models.ts` is a
protected merge authority allowlist and remains unchanged.

From a checkout with installed dependencies and an existing Phantom Secrets
binding for `ANTHROPIC_API_KEY`, run:

```sh
node --import tsx scripts/probe-model-capabilities.ts
```

The launcher runs `phantom exec -- node --import tsx ... --worker`. Only the
worker reads the proxy placeholder and loopback provider URL. It refuses raw
credentials, untrusted destinations and redirects. It fetches `GET /v1/models`
with bounded pagination, request timeouts and response sizes. Only allowlisted
public fields cross the child boundary. Neither response bodies nor child
error diagnostics are logged. No tokens are created or retrieved by this job.
Use Phantom Secrets and Locus to provision or repair existing access separately.

For a nightly host scheduler, use the absolute Node and checkout paths and run
from the checkout directory, for example this cron command at 02:17 local time:

```cron
17 2 * * * cd /absolute/phantom && /absolute/node --import tsx scripts/probe-model-capabilities.ts --force
```

This change supplies the scheduler entry but does not activate a host scheduler.
`--force` refreshes nightly regardless of yesterday's completion time. Without
it, a fresh cache avoids provider contact. A failed refresh exits nonzero and
preserves the previous file. The cache is atomically replaced with mode 0600 at
`~/.ashlr/cache/model-capabilities.json`, with schema version, provider and fetch
time. Consumers reject future timestamps, files older than 24 hours, oversized
files, symlinks at the file component and malformed data, then use static defaults.

The cache retains `line`, input/output limits, thinking support and each thinking
type independently, including `between_tools`, plus server tool support and the
individual web search and code execution flags. Missing flags remain unknown;
explicit `false` stays false. Routing overlays exact known Anthropic model IDs
and respects existing engine, historical model, cost and rollout filters. Claude
options and adapter budget resolution expose `providerCapabilities`, refreshing
metadata even for existing launch snapshots while preserving their CLI budgets.
API availability never proves subscription availability. API maximum output is
not the CLI's default output reserve.

The fixture suite uses in-memory storage and mocked HTTP responses, with no live
network or real credentials. The wire contract follows the
[Models API reference](https://platform.claude.com/docs/en/api/models/list) and
[capability definitions](https://platform.claude.com/docs/en/api/typescript/models).
This is also the cache contract available to `RQ-PARITY-ROUTER-TASK`.
