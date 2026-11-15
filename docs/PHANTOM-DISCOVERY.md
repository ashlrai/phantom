# Experimental Phantom peer discovery

Set `ASHLR_PHANTOM_DISCOVERY=1` when starting the Phantom web server to enable
`GET /api/phantom/discovery` and `GET /api/phantom/ping`. Both require the
server's existing read authority (`x-ashlr-token`); the server remains bound to
loopback. The flag defaults off. Discovery describes only the experimental
read-only ping operation, not the rest of Phantom's APIs. A peer must obtain the
read token through an existing trusted channel; discovery does not distribute it.

A peer can fetch the manifest with its read token and pass the parsed JSON to
`generatePhantomClient` from `core/web/phantom-discovery.js`. Write the returned
TypeScript to a file in the consuming project, compile it, and instantiate
`PhantomClient` with the server's base URL and read token. Its `ping()` method
returns `Promise<PingResponse>`. The generator rejects unknown versions and
contracts rather than emitting code from untrusted manifest strings. The client
rejects redirects and malformed responses. This initial protocol intentionally
supports only the exact v1 contract; future operations require a generator update.
