# Read the local knowledge graph over HTTP

Use `startGraphServer` from `@ashlr/phantom` or `@ashlr/phantom/core` to start an
independent read-only listener. It does not start the dashboard, dispatch work,
enroll repositories, or contact model providers. The default reader uses the
existing [knowledge graph](../src/core/knowledge/graph.ts) over enrolled local
repositories. With no enrollment, the result is an empty graph.

```ts
import { startGraphServer } from '@ashlr/phantom/core';

const server = await startGraphServer({ host: '127.0.0.1', port: 0 });
try {
  const response = await fetch(`${server.url}/graph`, {
    headers: { 'X-Ashlr-Token': server.readToken },
  });
  if (!response.ok) throw new Error(`Graph request failed: ${response.status}`);
  const graph = await response.json();
  // Consume graph.nodes, graph.edges, and graph.crossRepo locally.
} finally {
  await server.close();
}
```

The port defaults to `0` (an available ephemeral port); `server.port` and
`server.url` report the bound address. An explicit host must be the exact literal
`127.0.0.1`. Wildcards, other IPs, IPv6 and DNS names are rejected before binding.
An occupied or invalid port rejects startup. `close()` is idempotent and closes
active connections as well as the listener.

| Request | Response |
| --- | --- |
| `GET /graph` | The existing `KnowledgeGraph`: `nodes`, `edges`, `crossRepo`. |
| `GET /graph/nodes/:id` | One node with `id`, `kind`, `label`; missing IDs return `404`. |

Encode the entire node ID with `encodeURIComponent(id)`, including any slashes
or scoped package names. IDs are decoded once and matched exactly in memory;
they never select filesystem paths. Each request reads a fresh graph. No query
parameters, write methods, static assets, or additional endpoints are supported.
Unsupported methods return `405` with `Allow: GET`; malformed encoding and query
parameters return `400`. A thrown or rejected reader failure returns a generic
`503`. The default graph builder retains its existing best-effort behavior:
unreadable evidence can be omitted, so an empty graph is not proof of healthy
repositories.

Every request requires this listener's private `X-Ashlr-Token` header. Tokens
are created at startup and returned only on the handle; keep them out of logs,
URLs, and shared artifacts. Cookies and query strings cannot authenticate.
Host headers must name `127.0.0.1` or `localhost` with the actual bound port.
Browser requests carrying an Origin must match `server.url` exactly; cross-site
fetches are denied. Responses use `no-store` and `nosniff`, and the listener
emits no CORS headers. Use a local native client or a same-origin integration.

Embedders can inject a read-only `readGraph` function as the second argument to
`startGraphServer`. It must return a `KnowledgeGraph` or a promise of one. This
is a trusted in-process dependency, never an HTTP parameter.
