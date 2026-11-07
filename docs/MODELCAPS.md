# Refresh the model capability cache

The standalone runner records advertised `/v1/models` metadata in a local
`modelcaps.v1` cache. No router, model catalog, daemon or UI consumes this cache.
A listing is evidence of advertised metadata, not a successful inference call,
an account entitlement or permission to spend.

## Run a refresh

Use a trusted source checkout with Node 22.15+ and its existing dependencies
installed. Use an already configured Phantom Secrets project whose
`phantom exec --` supplies `OPENAI_API_KEY` as a `phm_` placeholder and
`OPENAI_BASE_URL` as its loopback proxy URL. See [companion setup](COMPANIONS.md).
No new credential is required or created by this change.

This command contacts the configured model-list endpoint and replaces the
provider's local cache after a complete successful response:

```sh
node scripts/modelcaps-nightly.mjs --provider openai
```

The runner invokes `phantom exec -- node ...` with a fixed source worker.
It refuses raw keys, remote base URLs, embedded URL credentials, query strings
and redirects. Only a GET request is issued; no completion, generation or
tool call is made. The existing Secrets project selects the upstream provider;
`--provider` only labels the cache and must match that project operationally.
Run from that project's directory with an absolute path to the runner if needed.

Default output is `~/.ashlr/modelcaps/PROVIDER.json`. Override it with
`--output ABS_PATH` using a dedicated private directory. Existing directories
are never chmodded or repaired. Paths must be canonical, with no symlink
ancestors; on macOS this includes resolving `/tmp` and `/var` aliases.
The writer uses the repository's private atomic file helper, a 0600 temporary
file, fsync and rename. Existing symlink or hard-linked cache files are refused.

## Schedule nightly

Use an existing authorized local scheduler. For example, a cron entry in the
configured Secrets project can invoke the runner at 02:00 local time:

```cron
0 2 * * * cd /absolute/secrets-project && /absolute/node /absolute/phantom/scripts/modelcaps-nightly.mjs --provider openai
```

The scheduler needs a PATH containing the trusted `phantom` executable. It must
be able to use the existing Secrets configuration noninteractively. Each
invocation runs once and exits; this change installs no schedule or service.
Do not put credentials in the entry or redirect raw Secrets output into logs.
The wrapper suppresses child stdout and stderr and emits only a fixed status
message. Exit 0 means refresh succeeded; exit 1 means the probe or writer failed.

## Cache contract

`schema` is exactly `modelcaps.v1`. `provider` is the operator-supplied label.
`observedAt` and `expiresAt` are ISO UTC timestamps, with expiry 24 hours after
the completed observation. `source` is `/v1/models`, not a credential-bearing
proxy URL. `models` is sorted by exact model ID, using case-sensitive ordering.

Each model has `id`, `contextWindowTokens`, `maxOutputTokens` and
`capabilities: { tools, vision, reasoning }`. Token counts come only from explicit
positive integer `context_length` and `max_output_tokens` fields. Each capability
is `true`, `false` or `null` (unknown). The parser accepts a capability object
with explicit booleans or a tag array; a recognized tag establishes `true`,
while omitted tags remain unknown. Model names never imply capabilities.
Unrecognized fields and capabilities are discarded, including raw metadata.
This parser does not claim to normalize every provider's extension format.

Valid empty listings are cached as an empty `models` array. Malformed rows,
duplicate IDs, error envelopes, pagination, non-200 responses, invalid UTF-8 or
JSON and responses over 2 MiB fail the entire refresh. The listing allows at
most 10,000 models. A ten-second deadline covers headers and streamed body.
There are no retries or direct-network fallbacks. Probe and validation failures
leave prior cache bytes and timestamps intact. As with other durable writers,
a filesystem failure after rename may report failure after replacement.
Expired files remain on disk as historical observations; no consumer currently
interprets freshness or grants authority from this file.

## Verify offline

Fixture responses and injected transports exercise parsing, persistence and
failure handling without contacting providers or creating credentials:

```sh
HOME=$(mktemp -d) npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/modelcaps.test.ts test/modelcaps-nightly.test.ts
HOME=$(mktemp -d) npm run typecheck
HOME=$(mktemp -d) npm run lint
HOME=$(mktemp -d) npm run check:docs
```
