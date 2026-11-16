import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFleetHandoffsApi, VERSE_FLEET_HANDOFFS_PATH } from '../src/core/verse/fleet-handoffs-api.js';
import type { FleetHandoffsApiDeps } from '../src/core/verse/fleet-handoffs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const observedAt = '2026-11-05T22:37:00.000Z';
const rows = [
  { folder: 'agent-one', name: 'handoff.md', size: 12, modifiedAt: '2026-11-05T21:46:00.000Z', preview: 'Fake handoff' },
  { folder: 'agent-two', name: 'next.md', size: 4, modifiedAt: '2026-11-04T00:00:00.000Z', preview: 'Next' },
];

async function withServer(
  setup: (runsDir: string) => Promise<void>,
  list: NonNullable<FleetHandoffsApiDeps['list']>,
  run: (request: (path?: string, method?: string) => Promise<Response>, runsDir: string) => Promise<void>,
  allowDispatch = true,
): Promise<void> {
  const runsDir = await mkdtemp(join(tmpdir(), 'handoff-api-contract-'));
  const api = createFleetHandoffsApi({ runsDir, list, now: () => new Date(observedAt) });
  const ctx = { cfg: {}, token: 'fake-token', allowDispatch } as VerseApiContext;
  const server = createServer((req, res) => {
    void api(ctx, req, res, new URL(req.url ?? '/', 'http://localhost').pathname, req.method ?? 'GET')
      .then(handled => { if (!handled) { res.writeHead(418); res.end('declined'); } })
      .catch(() => { res.writeHead(500); res.end(); });
  });
  try {
    await setup(runsDir);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    await run((path = VERSE_FLEET_HANDOFFS_PATH, method = 'GET') =>
      fetch(`http://127.0.0.1:${address.port}${path}`, { method }), runsDir);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await rm(runsDir, { recursive: true, force: true });
  }
}

const present = async (runsDir: string) => { await mkdir(join(runsDir, 'handoff')); };
const absent = async () => {};

async function json(response: Response, runsDir: string): Promise<unknown> {
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(runsDir);
  expect(body).not.toContain('runsDir');
  return JSON.parse(body) as unknown;
}

describe('Library handoffs HTTP response contract', () => {
  it('returns the exact reader rows with the fixed observation time', async () => {
    const list = vi.fn(async () => rows);
    await withServer(present, list, async (request, runsDir) => {
      expect(await json(await request(), runsDir)).toEqual({ v: 1, observedAt, handoffs: rows });
      expect(list).toHaveBeenCalledExactlyOnceWith(runsDir);
    });
  });

  it('distinguishes an absent directory from an empty inbox', async () => {
    const list = vi.fn(async () => []);
    await withServer(absent, list, async (request, runsDir) => {
      expect(await json(await request(), runsDir)).toEqual({ v: 1, observedAt, handoffs: [], state: 'absent' });
      expect(list).not.toHaveBeenCalled();
    });
    await withServer(present, list, async (request, runsDir) => {
      expect(await json(await request(), runsDir)).toEqual({ v: 1, observedAt, handoffs: [] });
      expect(list).toHaveBeenCalledExactlyOnceWith(runsDir);
    });
  });

  it('reports a non-directory handoff path as unavailable', async () => {
    const list = vi.fn(async () => []);
    await withServer(async dir => { await writeFile(join(dir, 'handoff'), 'fake'); }, list, async (request, runsDir) => {
      expect(await json(await request(), runsDir)).toEqual({ v: 1, observedAt, handoffs: [], state: 'unavailable' });
      expect(list).not.toHaveBeenCalled();
    });
  });

  it('hides reader errors and reports unavailable', async () => {
    const list = vi.fn(async () => { throw new Error('fake private error detail'); });
    await withServer(present, list, async (request, runsDir) => {
      expect(await json(await request(), runsDir)).toEqual({ v: 1, observedAt, handoffs: [], state: 'unavailable' });
      expect(list).toHaveBeenCalledExactlyOnceWith(runsDir);
    });
  });

  it('refuses a caller without dispatch permission without reading', async () => {
    const list = vi.fn(async () => rows);
    await withServer(present, list, async request => {
      const response = await request();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
      expect(list).not.toHaveBeenCalled();
    }, false);
  });

  it('declines other paths and rejects unsupported methods', async () => {
    const list = vi.fn(async () => rows);
    await withServer(present, list, async request => {
      const other = await request('/api/verse/fleet/other');
      expect(other.status).toBe(418);
      expect(await other.text()).toBe('declined');
      const post = await request(VERSE_FLEET_HANDOFFS_PATH, 'POST');
      expect(post.status).toBe(405);
      expect(await post.json()).toEqual({ error: 'method not allowed' });
      expect(list).not.toHaveBeenCalled();
    });
  });
});
