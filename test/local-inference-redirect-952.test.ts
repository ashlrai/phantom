/**
 * Security #952 L1 and L3: local-inference probes never follow a 3xx. A
 * redirect from the local service reads as down (or as no size data), and
 * the redirect target is never contacted. Real loopback HTTP, no mocks.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeEndpoint } from '../src/core/providers.js';
import { listLocalModels } from '../src/core/run/model-manager.js';
import type { AshlrConfig } from '../src/core/types.js';

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
  servers = [];
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ base: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler!(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const redirectAll = (_req: unknown, res: import('node:http').ServerResponse) => {
  res.writeHead(302, { location: '/must-not-follow' });
  res.end();
};

describe('probeEndpoint refuses a redirect from a local endpoint', () => {
  it.each(['ollama', 'lmstudio'])('%s: a 302 reads as unreachable and the target is never fetched', async (id) => {
    const { base, requests } = await serve(redirectAll);
    const out = await probeEndpoint(id, base);
    expect(out.up).toBe(false);
    expect(out.models).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests.some((r) => r.includes('must-not-follow'))).toBe(false);
  });
});

describe('listLocalModels size lookup refuses a redirect', () => {
  it('a 3xx on the size fetch is not followed and yields no size label', async () => {
    let tags = 0;
    const { base, requests } = await serve((req, res) => {
      if (req.url === '/api/tags' && tags++ === 0) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen:7b', size: 4_000_000_000 }] }));
        return;
      }
      redirectAll(req, res);
    });
    const cfg = { models: { ollama: base, lmstudio: 'http://127.0.0.1:1' } } as unknown as AshlrConfig;
    const models = await listLocalModels(cfg);
    expect(requests.some((r) => r.includes('must-not-follow'))).toBe(false);
    for (const m of models) expect(m.sizeLabel ?? undefined).toBeUndefined();
  });
});
