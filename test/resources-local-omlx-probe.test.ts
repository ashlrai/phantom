import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { senseLocalState } from '../src/core/fabric/resource-monitor.js';

let port: number;
let ollama = 503;
let omlx = 503;
let slow = false;
let requests: Array<{ path: string | undefined; method: string | undefined; auth: string | undefined }> = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  requests.push({ path: req.url, method: req.method, auth: req.headers.authorization });
  if (slow && req.url === '/v1/models') return;
  res.statusCode = req.url === '/api/ps' ? ollama : omlx;
  if (res.statusCode === 503) { res.destroy(); return; }
  res.end(JSON.stringify({ models: [] }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
beforeEach(() => { ollama = 503; omlx = 503; slow = false; requests = []; });
const probe = () => senseLocalState('local-coder', { local: { baseUrl: `http://127.0.0.1:${port}`, maxConcurrent: 2 } }, port);

describe('resources local runtime probe', () => {
  it('reports oMLX when only oMLX is up, without claiming occupancy', async () => {
    omlx = 200;
    const state = await probe();
    expect(state).toMatchObject({ backend: 'local-coder', availability: 'open', usedPct: null, cap: 2, reason: 'oMLX reachable; occupancy unknown' });
    expect(Object.keys(state).sort()).toEqual(['availability', 'backend', 'backoffUntilMs', 'cap', 'capUnit', 'capWindow', 'costPerMTokenOut', 'p50LatencyMs', 'reason', 'resetsAt', 'snapshotAt', 'usedPct'].sort());
    expect(requests).toEqual(expect.arrayContaining([
      { path: '/api/ps', method: 'GET', auth: undefined }, { path: '/v1/models', method: 'GET', auth: undefined },
    ]));
  });
  it('reports Ollama and its occupancy when only Ollama is up', async () => {
    ollama = 200;
    expect(await probe()).toMatchObject({ availability: 'open', usedPct: 0, reason: 'ollama idle: 0/2 concurrent' });
  });
  it('reports unreachable when both are down', async () => {
    expect(await probe()).toMatchObject({ availability: 'unreachable', reason: 'ollama and oMLX unreachable' });
  });
  it('does not send a configured non-loopback Ollama request', async () => {
    const state = await senseLocalState('local-coder', { local: { baseUrl: 'http://example.invalid:11434' } }, port);
    expect(state.availability).toBe('unreachable');
    expect(requests.map((request) => request.path)).toEqual(['/v1/models']);
  });
  it('rejects a nonnumeric oMLX port', async () => {
    await senseLocalState('local-coder', { local: { baseUrl: `http://127.0.0.1:${port}` } }, '8123@example.invalid' as unknown as number);
    expect(requests.map((request) => request.path)).toEqual(['/api/ps']);
  });
  it('prefers Ollama occupancy when both answer', async () => {
    ollama = 200; omlx = 200;
    expect((await probe()).reason).toBe('ollama idle: 0/2 concurrent');
  });
  it('times out a slow oMLX endpoint', async () => {
    slow = true;
    const start = Date.now();
    expect((await probe()).availability).toBe('unreachable');
    expect(Date.now() - start).toBeLessThan(3500);
  });
});
