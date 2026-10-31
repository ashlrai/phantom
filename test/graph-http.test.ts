import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startGraphServer, type GraphHttpHandle } from '../src/api/graph-http.js';
import type { KnowledgeGraph } from '../src/core/types.js';

const graph: KnowledgeGraph = {
  nodes: [
    { id: 'repo:example', kind: 'repo', label: 'Example' },
    { id: 'module:example/src/a b.ts', kind: 'module', label: 'a b.ts' },
    { id: 'dep:@scope/pkg', kind: 'dep', label: '@scope/pkg' },
    { id: 'literal:%2F?#λ', kind: 'module', label: 'Opaque ID' },
  ],
  edges: [{ from: 'repo:example', to: 'dep:@scope/pkg', kind: 'depends' }],
  crossRepo: [{ kind: 'shared-dep', detail: '@scope/pkg', repos: ['example', 'other'] }],
};
const handles: GraphHttpHandle[] = [];
async function start(readGraph = vi.fn<() => KnowledgeGraph | Promise<KnowledgeGraph>>(() => graph)) {
  const handle = await startGraphServer({ port: 0 }, { readGraph });
  handles.push(handle);
  return { handle, readGraph };
}

// Fast loopback-only integration cases: one ephemeral listener, no subprocesses
// or external I/O. Each listener is closed even when an assertion fails.
function request(handle: GraphHttpHandle, path = '/graph', options: {
  method?: string; headers?: Record<string, string>; authenticated?: boolean;
} = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: handle.port, path,
      method: options.method ?? 'GET', agent: false,
      headers: {
        ...(options.authenticated === false ? {} : { 'X-Ashlr-Token': handle.readToken }),
        ...options.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(2_000, () => req.destroy(new Error('Graph request timed out')));
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe('read-only graph HTTP', () => {
  it('serves the full graph through a real loopback listener with private JSON headers', async () => {
    const { handle, readGraph } = await start();
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
    const response = await request(handle);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(graph);
    expect(response.headers).toMatchObject({ 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin' });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(readGraph).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(graph.nodes)('returns the exact node for encoded ID $id', async (node) => {
    const { handle } = await start();
    const response = await request(handle, `/graph/nodes/${encodeURIComponent(node.id)}`);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(node);
  });

  it('returns 404 for a missing node, including prototype property names', async () => {
    const { handle } = await start();
    for (const id of ['missing', '__proto__', 'constructor', 'dep:@scope/unknown']) {
      expect((await request(handle, `/graph/nodes/${encodeURIComponent(id)}`)).status).toBe(404);
    }
  });

  it('reads fresh evidence on each request', async () => {
    const { handle, readGraph } = await start();
    await request(handle);
    readGraph.mockReturnValue({ nodes: [], edges: [], crossRepo: [] });
    const response = await request(handle);
    expect(JSON.parse(response.body)).toEqual({ nodes: [], edges: [], crossRepo: [] });
    expect(readGraph).toHaveBeenCalledTimes(2);
  });

  it('decodes once rather than treating double-encoded IDs as aliases', async () => {
    const { handle } = await start();
    const response = await request(handle, `/graph/nodes/${encodeURIComponent(encodeURIComponent(graph.nodes[1]!.id))}`);
    expect(response.status).toBe(404);
  });

  it('requires the private header token, never cookies or a query token', async () => {
    const { handle, readGraph } = await start();
    for (const headers of [{}, { 'X-Ashlr-Token': 'wrong' }, { Cookie: 'ashlr_read_session=wrong' }]) {
      expect((await request(handle, '/graph', { authenticated: false, headers })).status).toBe(401);
    }
    expect((await request(handle, '/graph?token=wrong', { authenticated: false })).status).toBe(401);
    expect(readGraph).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE'])('refuses %s before reading', async (method) => {
    const { handle, readGraph } = await start();
    for (const path of ['/graph', '/graph/nodes/repo%3Aexample']) {
      const response = await request(handle, path, { method });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('GET');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(readGraph).not.toHaveBeenCalled();
  });

  it.each(['attacker.test', '127.0.0.1.evil.test', '127.0.0.1:1', '[::1]:1'])('rejects Host %s before reading', async (host) => {
    const { handle, readGraph } = await start();
    expect((await request(handle, '/graph', { headers: { Host: host } })).status).toBe(403);
    expect(readGraph).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.test', 'null', 'http://127.0.0.1:1'])('rejects Origin %s with a valid token', async (origin) => {
    const { handle, readGraph } = await start();
    const response = await request(handle, '/graph', { headers: { Origin: origin } });
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(readGraph).not.toHaveBeenCalled();
  });

  it('allows the advertised origin and refuses cross-site fetches', async () => {
    const { handle, readGraph } = await start();
    expect((await request(handle, '/graph', { headers: { Origin: handle.url } })).status).toBe(200);
    readGraph.mockClear();
    expect((await request(handle, '/graph', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect(readGraph).not.toHaveBeenCalled();
  });

  it.each(['/graph?repos=/private', '/graph?root=/private', '/graph#fragment', '//graph',
    'http://attacker.test/graph', '/graph/nodes/%ZZ', '/graph/nodes/%E0%A4', '/graph/nodes/%00',
    '/graph/nodes/%7F', '/graph/nodes/%C2%85']) (
    'rejects malformed or unsupported target %s before reading', async (path) => {
      const { handle, readGraph } = await start();
      expect((await request(handle, path)).status).toBe(400);
      expect(readGraph).not.toHaveBeenCalled();
    },
  );

  it.each(['/missing', '/graph/', '/graph/nodes/', '/graph/nodes/a/b', '/graph/nodes/../graph']) (
    'does not normalize or dispatch unknown path %s', async (path) => {
      const { handle, readGraph } = await start();
      expect((await request(handle, path)).status).toBe(404);
      expect(readGraph).not.toHaveBeenCalled();
    },
  );

  it.each(['sync', 'async'])('contains %s reader errors and remains available', async (mode) => {
    const { handle, readGraph } = await start();
    if (mode === 'sync') readGraph.mockImplementationOnce(() => { throw new Error('private source detail'); });
    else readGraph.mockRejectedValueOnce(new Error('private source detail'));
    const response = await request(handle);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'Graph is temporarily unavailable' });
    expect((await request(handle)).status).toBe(200);
  });

  it('uses the default enrollment-scoped reader without creating home state', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const home = homedir();
    const before = existsSync(home) ? readdirSync(home) : [];
    const handle = await startGraphServer();
    handles.push(handle);
    const response = await request(handle);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ nodes: [], edges: [], crossRepo: [] });
    expect(readdirSync(home)).toEqual(before);
  });

  it.each(['0.0.0.0', '::', '::1', 'localhost', '127.0.0.2', '192.168.1.10', '', '127.1']) (
    'non-loopback-bind-fails: %j', async (host) => {
      const readGraph = vi.fn(() => graph);
      await expect(startGraphServer({ host }, { readGraph })).rejects.toThrow('must bind to 127.0.0.1');
      expect(readGraph).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 65536, 1.5, NaN, Infinity])('rejects invalid port %s', async (port) => {
    await expect(startGraphServer({ port })).rejects.toThrow('Invalid graph HTTP port');
  });

  it('rejects an occupied port and permits reuse after idempotent close', async () => {
    const { handle } = await start();
    await expect(startGraphServer({ host: '127.0.0.1', port: handle.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const closing = handle.close();
    expect(handle.close()).toBe(closing);
    await closing;
    const next = await startGraphServer({ port: handle.port }, { readGraph: () => graph });
    handles.push(next);
    expect((await request(next)).status).toBe(200);
    expect((await request(next, '/graph', { headers: { 'X-Ashlr-Token': handle.readToken } })).status).toBe(401);
  });

  it('closes active sockets without waiting for an in-flight reader', async () => {
    let release!: (value: KnowledgeGraph) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const readGraph = vi.fn(() => new Promise<KnowledgeGraph>((resolve) => {
      release = resolve;
      notifyStarted();
    }));
    const { handle } = await start(readGraph);
    const response = request(handle).then(() => 'unexpected response', () => 'connection closed');
    await started;
    try {
      await handle.close();
      expect(await response).toBe('connection closed');
    } finally {
      release(graph);
    }
  });
});
