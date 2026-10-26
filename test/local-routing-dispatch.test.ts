import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLocalInferenceConfig } from '../src/core/run/local-inference.js';
import { probeLocalInference } from '../src/core/run/local-inference-probe.js';
import { hybridLocalEscalation } from '../src/core/fleet/tick-hooks-live.js';
import { localEscalationInputFor } from '../src/core/fleet/dispatch-router.js';
import type { AshlrConfig } from '../src/core/config.js';

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
    expect(hybridLocalEscalation(cfgOf(li({ routing: 'hybrid' })), probe)).toEqual({
      localEscalation: { localAvailable: true, localModel: 'qwen3-coder' },
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
  const base = { localAvailable: true, localModel: 'qwen3-coder' };
  it('maps attempts to retries and keeps the base', () => {
    const input = localEscalationInputFor({ effort: 'small', source: 'issue', tags: [], title: 't', detail: '', attempts: 2 } as never, base);
    expect(input.localAvailable).toBe(true);
    expect(input.kind === 'edit' || input.kind === 'architecture').toBe(true);
  });
});
