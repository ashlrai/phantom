import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { senseLocalState } from '../src/core/fabric/resource-monitor.js';

let port: number;
const requests: Array<{ path: string | undefined; method: string | undefined }> = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  requests.push({ path: req.url, method: req.method });
  res.statusCode = 503;
  res.end();
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('resources local oMLX probe — missing request branch', () => {
  it('degrades to unreachable without throwing when no Ollama request is created', async () => {
    // An https base URL passes the loopback gate but fails ollamaPs()'s
    // http-only check, so the probe resolves null before any ClientRequest
    // exists — the missing-request branch.
    const state = await senseLocalState(
      'local-coder',
      { local: { baseUrl: `https://127.0.0.1:${port}`, maxConcurrent: 2 } },
      port,
    );
    expect(state).toMatchObject({
      backend: 'local-coder',
      availability: 'unreachable',
      usedPct: null,
      reason: 'ollama and oMLX unreachable',
      backoffUntilMs: null,
    });
    expect(requests.map((request) => request.path)).toEqual(['/v1/models']);
  });
});
