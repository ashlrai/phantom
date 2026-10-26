import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLocalInferenceConfig } from '../src/core/run/local-inference.js';
import { probeLocalInference } from '../src/core/run/local-inference-probe.js';
import { hybridLocalEscalation } from '../src/core/fleet/tick-hooks-live.js';
import { localEscalationInputFor } from '../src/core/fleet/dispatch-router.js';
import type { AshlrConfig } from '../src/core/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routingEnginesFromConfig } from '../src/core/routing/routing-engines.js';
import { classifyEngine, engineClassMayHoldSecrets, engineClassMayMergeOrPublish } from '../src/core/routing/local-route.js';
import { appendRoutingLedger, readRoutingLedger, recordRoutingDecision, routingLedgerEntry } from '../src/core/routing/routing-ledger.js';
import { checkRouting } from '../src/core/doctor.js';

// Fake loopback /v1 server only. No real model runtime is touched.
let server: Server;
let baseUrl = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const li = (extra: Record<string, unknown> = {}) => ({ provider: 'openai-compat', baseUrl, models: { coder: 'qwen3-coder' }, ...extra });
const cfgOf = (localInference: unknown) => ({ localInference }) as unknown as AshlrConfig;

describe('localInference.routing opt-in', () => {
  it('defaults to off and accepts hybrid', () => {
    expect(parseLocalInferenceConfig(li()).config?.routing).toBe('off');
    expect(parseLocalInferenceConfig(li({ routing: 'hybrid' })).config?.routing).toBe('hybrid');
  });
  it('rejects an unknown routing value', () => {
    expect(parseLocalInferenceConfig(li({ routing: 'always' })).ok).toBe(false);
  });
});

describe('hybridLocalEscalation against a fake loopback /v1 server', () => {
  it('is inert unless routing is hybrid', async () => {
    const probe = await probeLocalInference(li());
    expect(probe.reachable).toBe(true);
    expect(hybridLocalEscalation(cfgOf(li()), probe)).toEqual({});
  });
  it('marks local available when the probe reaches the server', async () => {
    const probe = await probeLocalInference(li({ routing: 'hybrid' }));
    expect(hybridLocalEscalation(cfgOf(li({ routing: 'hybrid' })), probe)).toMatchObject({
      localEscalation: { localAvailable: true, localModel: 'qwen3-coder', route: { engines: { 'openai-compat': { tier: 'local' } } } },
    });
  });
  it('marks local unavailable when the server is down', () => {
    expect(hybridLocalEscalation(cfgOf(li({ routing: 'hybrid' })), { reachable: false }).localEscalation?.localAvailable).toBe(false);
  });
  it('never throws on garbage config', () => {
    expect(hybridLocalEscalation(cfgOf('nope'), { reachable: true })).toEqual({});
  });
});

describe('localEscalationInputFor', () => {
  const base = { localAvailable: true, localModel: 'qwen3-coder', route: { localInference: undefined } };
  it('maps attempts to retries and keeps the base', () => {
    const input = localEscalationInputFor({ effort: 'small', source: 'issue', tags: [], title: 't', detail: '', attempts: 2 } as never, base);
    expect(input.localAvailable).toBe(true);
    expect(input.retries).toBe(2);
    expect('route' in input).toBe(false);
    expect(input.kind === 'edit' || input.kind === 'architecture').toBe(true);
  });
});

describe('routingEnginesFromConfig (ctx.engines from config)', () => {
  const cfg = {
    engines: {
      mylocal: { id: 'mylocal', kind: 'api-model', tier: 'mid', api: { envKey: 'SECRET_ENV', defaultBaseUrl: 'http://127.0.0.1:9000/v1', protocol: 'openai' } },
      hosted: { id: 'hosted', kind: 'api-model', tier: 'frontier', api: { envKey: 'K', defaultBaseUrl: 'https://api.example.com/v1', protocol: 'openai' } },
    },
    localInference: { provider: 'ollama' },
  } as unknown as AshlrConfig;
  const engines = routingEnginesFromConfig(cfg);
  it('projects only id, endpoint and tier (no envKey)', () => {
    expect(JSON.stringify(engines)).not.toContain('SECRET_ENV');
    expect(engines['openai-compat']).toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', tier: 'local' });
  });
  it('classifies custom loopback as local, public https as frontier, unknown as unclassified', () => {
    expect(classifyEngine({ engine: 'mylocal' } as never, engines)).toBe('local');
    expect(classifyEngine({ engine: 'hosted' } as never, engines)).toBe('frontier');
    expect(classifyEngine({ engine: 'mystery' } as never, engines)).toBe('unclassified');
    expect(classifyEngine({ engine: 'mystery' } as never, undefined)).toBe('unclassified');
  });
  it('devin gets the same merge eligibility as every hosted engine (outcome gates apply)', () => {
    const cls = classifyEngine({ engine: 'devin' } as never, engines);
    expect(cls).toBe(classifyEngine({ engine: 'claude' } as never, engines));
    expect(engineClassMayMergeOrPublish(cls)).toBe(true);
    expect(engineClassMayHoldSecrets(cls)).toBe(false);
  });
});

describe('dispatch security', () => {
  it('localhost endpoints dial 127.0.0.1 with no name resolution', () => {
    expect(parseLocalInferenceConfig({ provider: 'openai-compat', baseUrl: 'http://localhost:8080/v1' }).config?.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(parseLocalInferenceConfig({ provider: 'openai-compat', baseUrl: 'http://[::1]:8080/v1' }).config?.baseUrl).toBe('http://[::1]:8080/v1');
  });
  it('the probe refuses to follow redirects', async () => {
    let seen: RequestInit | null = null;
    await probeLocalInference(li(), { fetchImpl: async (_u, init) => { seen = init; throw new Error('x'); } });
    expect(seen!.redirect).toBe('error');
  });
});

describe('routing ledger (status --json)', () => {
  it('records tier, engine and reason, bounded', () => {
    let l = null as ReturnType<typeof appendRoutingLedger> | null;
    for (let i = 0; i < 105; i++) {
      l = appendRoutingLedger(l, routingLedgerEntry(`i${i}`, 'claude', { seatId: 's', lane: 'frontier', laneReason: 'policy-off' } as never, {}));
    }
    expect(l!.entries).toHaveLength(100);
    expect(l!.counts.frontier).toBe(100);
    const e = routingLedgerEntry('x', 'mystery', null, {});
    expect(e).toMatchObject({ engineClass: 'unclassified', lane: 'frontier', reason: 'policy-off', seatId: null });
  });
  it('round-trips through disk and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rl-'));
    const path = join(dir, 'routing', 'last-run.json');
    recordRoutingDecision('a', 'codex', null, {}, path);
    expect(readRoutingLedger(path)?.entries[0]?.engine).toBe('codex');
    writeFileSync(join(dir, 'blocker'), 'x');
    expect(() => recordRoutingDecision('a', 'codex', null, {}, join(dir, 'blocker', 'x.json'))).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('doctor routing row (never fails)', () => {
  const up = async () => new Response(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }), { status: 200 });
  it('warns when absent, invalid, or missing a coder model, and passes when the loopback server is up', async () => {
    expect((await checkRouting(cfgOf(undefined))).status).toBe('warn');
    expect((await checkRouting(cfgOf('nope'))).status).toBe('warn');
    expect((await checkRouting(cfgOf({ provider: 'ollama', routing: 'hybrid' }))).status).toBe('warn');
    expect((await checkRouting(cfgOf({ provider: 'ollama', routing: 'hybrid', models: { coder: 'qwen3-coder' } }), { fetchImpl: up })).status).toBe('pass');
  });
  it('warns on an unclassified configured engine', async () => {
    const cfg = { localInference: { provider: 'ollama', routing: 'hybrid', models: { coder: 'q' } }, engines: { weird: { id: 'weird', kind: 'cli-agent', tier: 'frontier' } } } as unknown as AshlrConfig;
    const c = await checkRouting(cfg, { fetchImpl: up });
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('weird');
    expect(c.status).not.toBe('fail');
  });
});
