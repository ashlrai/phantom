/**
 * P3: local inference probe (GET <base>/models only, loopback, no key, value-free),
 * the doctor check built on it, and the phm handshake capability.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkLocalInference } from '../src/core/doctor.js';
import { modelIdsFromBody, probeLocalInference, type ProbeFetch } from '../src/core/run/local-inference-probe.js';
import { buildPhmHandshake, PHM_HANDSHAKE_CAPABILITIES } from '../src/cli/handshake.js';
import { probeEndpoint } from '../src/core/providers.js';
import { listLocalModels } from '../src/core/run/model-manager.js';
import type { AshlrConfig } from '../src/core/types.js';

type Call = { url: string; init: RequestInit };
function fake(status: number, body: string): { calls: Call[]; f: ProbeFetch } {
  const calls: Call[] = [];
  return { calls, f: async (url, init) => { calls.push({ url, init }); return new Response(body, { status }); } };
}
const ollama = (models?: Record<string, string>) => ({ provider: 'ollama', ...(models ? { models } : {}) });

describe('probeLocalInference', () => {
  it('not configured or invalid: no request', async () => {
    const r = fake(200, '{}');
    expect((await probeLocalInference(undefined, { fetchImpl: r.f })).status).toBe('not-configured');
    expect((await probeLocalInference({ provider: 'nope' }, { fetchImpl: r.f })).status).toBe('config-invalid');
    expect(r.calls).toEqual([]);
  });

  it('remote endpoint (allowRemote) is never probed', async () => {
    const r = fake(200, '{}');
    const p = await probeLocalInference({ provider: 'openai-compat', baseUrl: 'https://gpu.example.com/v1', allowRemote: true }, { fetchImpl: r.f });
    expect(p).toMatchObject({ status: 'remote-not-probed', loopback: false, reachable: false });
    expect(r.calls).toEqual([]);
  });

  it('GET <base>/models only: no key header, no body, redirects refused', async () => {
    const r = fake(200, JSON.stringify({ data: [{ id: 'qwen3.8:27b' }] }));
    await probeLocalInference(ollama(), { fetchImpl: r.f });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe('http://127.0.0.1:11434/v1/models');
    expect(r.calls[0]!.init.method).toBe('GET');
    expect(r.calls[0]!.init.body).toBeUndefined();
    expect(r.calls[0]!.init.redirect).toBe('error');
    expect(JSON.stringify(r.calls[0]!.init.headers)).not.toMatch(/authorization/i);
  });

  it('reachable: models listed, role presence (digest pin ignored for matching)', async () => {
    const r = fake(200, JSON.stringify({ data: [{ id: 'qwen3.8:27b' }, { id: 'x-abliterated' }, { id: 'bad id with spaces' }] }));
    const p = await probeLocalInference(
      { provider: 'ollama', allowAbliterated: true, models: { coder: 'qwen3.8:27b', reviewer: 'qwen3.6:27b-coding', proposalOnly: `x-abliterated@sha256:${'b'.repeat(64)}` } },
      { fetchImpl: r.f },
    );
    expect(p).toMatchObject({ status: 'reachable', reachable: true, httpStatus: 200, modelCount: 3, models: ['qwen3.8:27b', 'x-abliterated'] });
    expect(p.rolesPresent).toEqual({ coder: true, reviewer: false, proposalOnly: true });
  });

  it('non-200, non-JSON and network errors are value-free', async () => {
    expect(await probeLocalInference(ollama(), { fetchImpl: fake(401, 'Unauthorized secret-detail').f })).toMatchObject({ status: 'bad-response', reachable: true, httpStatus: 401, models: [] });
    expect((await probeLocalInference(ollama(), { fetchImpl: fake(200, '<html>').f })).status).toBe('bad-response');
    const down = await probeLocalInference(ollama(), { fetchImpl: async () => { throw new Error('ECONNREFUSED 127.0.0.1:11434 secret'); } });
    expect(down).toMatchObject({ status: 'unreachable', reachable: false });
    expect(JSON.stringify(down)).not.toContain('secret');
  });

  it('times out quickly against a server that never answers', async () => {
    const t0 = Date.now();
    const p = await probeLocalInference(ollama(), { timeoutMs: 50, fetchImpl: (_u, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))) });
    expect(p.status).toBe('unreachable');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('parses OpenAI and Ollama model list shapes', () => {
    expect(modelIdsFromBody({ data: [{ id: 'a' }] })).toEqual(['a']);
    expect(modelIdsFromBody({ models: [{ name: 'b' }] })).toEqual(['b']);
    expect(modelIdsFromBody({ nope: 1 })).toBeNull();
  });
});

describe('real loopback server', () => {
  let server: Server;
  let port = 0;
  const seen: { method?: string; url?: string; auth?: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8:27b' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('probes the real server with one unauthenticated GET /v1/models', async () => {
    const p = await probeLocalInference({ provider: 'openai-compat', baseUrl: `http://127.0.0.1:${port}/v1`, models: { coder: 'qwen3.8:27b' } });
    expect(p).toMatchObject({ status: 'reachable', modelCount: 1, rolesPresent: { coder: true } });
    expect(seen).toEqual([{ method: 'GET', url: '/v1/models', auth: undefined }]);
  });
});

describe('doctor check', () => {
  const cfg = (li?: unknown) => ({ localInference: li }) as never;
  it('pass when not configured; warn when unreachable; warn with pull hint when a role model is missing', async () => {
    expect(await checkLocalInference(cfg())).toMatchObject({ id: 'local-inference', status: 'pass' });
    const down = await checkLocalInference(cfg(ollama()), { fetchImpl: async () => { throw new Error('x'); } });
    expect(down).toMatchObject({ status: 'warn', fix: 'Start it: ollama serve' });
    const miss = await checkLocalInference(cfg(ollama({ coder: 'qwen3.8:27b' })), { fetchImpl: fake(200, JSON.stringify({ data: [] })).f });
    expect(miss.status).toBe('warn');
    expect(miss.detail).toContain('missing model for coder');
    expect(miss.fix).toContain('ollama pull');
    const ok = await checkLocalInference(cfg(ollama({ coder: 'qwen3.8:27b' })), { fetchImpl: fake(200, JSON.stringify({ data: [{ id: 'qwen3.8:27b' }] })).f });
    expect(ok).toMatchObject({ status: 'pass', detail: 'ollama: reachable, 1 model(s)' });
  });
});

describe('phm handshake', () => {
  it('v1 shape advertises local-inference-probe; config health is local only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phm-hs-'));
    try {
      const none = buildPhmHandshake('9.9.9', { configPath: join(dir, 'missing.json') });
      expect(none).toMatchObject({ kind: 'ashlr.handshake', schema_version: 1, command: 'phm', version: '9.9.9', health: { status: 'ok', checks: [{ id: 'local-inference-config', status: 'absent' }] } });
      expect(none['capabilities']).toContain('local-inference-probe');
      for (const c of PHM_HANDSHAKE_CAPABILITIES) expect(c).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify({ localInference: { provider: 'ollama' } }));
      expect(buildPhmHandshake('1', { configPath: good })['health']).toEqual({ status: 'ok', checks: [{ id: 'local-inference-config', status: 'ok' }] });
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ localInference: { provider: 'ollama', baseUrl: 'http://10.0.0.9/v1' } }));
      const h = buildPhmHandshake('1', { configPath: bad });
      expect(h['health']).toEqual({ status: 'degraded', checks: [{ id: 'local-inference-config', status: 'missing' }] });
      expect(JSON.stringify(h)).not.toContain('10.0.0.9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('probe body cap (stream, abort past 256 KiB)', () => {
  it('a 300 MB-style endless reply is cancelled after just over the cap, never buffered', async () => {
    let pulled = 0; let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled += chunk.byteLength; if (pulled > 300 * 1024 * 1024) c.close(); else c.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const f: ProbeFetch = async () => new Response(stream, { status: 200 });
    const p = await probeLocalInference(ollama(), { fetchImpl: f });
    expect(p.status).toBe('bad-response');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(256 * 1024 + 2 * chunk.byteLength);
  });

  it('a declared oversize content-length is refused without reading', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } });
    const f: ProbeFetch = async () => new Response(stream, { status: 200, headers: { 'content-length': String(300 * 1024 * 1024) } });
    expect((await probeLocalInference(ollama(), { fetchImpl: f })).status).toBe('bad-response');
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it('a body under the cap still parses', async () => {
    const r = fake(200, JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    expect((await probeLocalInference(ollama(), { fetchImpl: r.f })).status).toBe('reachable');
  });
});

// Redirect regressions share this suite's existing real-I/O lane.
describe('local provider redirects', () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    servers = [];
  });

  async function serve(handler: RequestListener): Promise<{ base: string; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res);
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
      expect(models.map((m) => m.name)).toEqual(['qwen:7b']);
      expect(requests.filter((r) => r === 'GET /api/tags')).toHaveLength(2);
      for (const m of models) expect(m.sizeLabel).toBeUndefined();
    });
  });
});
