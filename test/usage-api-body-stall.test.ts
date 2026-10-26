/**
 * test/usage-api-body-stall.test.ts — the usage API deadline covers the body.
 *
 * A server that sends response headers and then never finishes the body used
 * to hang fetchClaudeUsageApi() forever, because the abort timer was cleared
 * as soon as the headers arrived. The deadline must stay armed through the
 * body read so the call settles (as null, the timeout result) within it.
 *
 * Real IO: a loopback HTTP server; the global fetch is wrapped only to
 * redirect the hardcoded endpoint to that server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const realFetch = globalThis.fetch;
let server: Server | undefined;
const openResponses: ServerResponse[] = [];
let origToken: string | undefined;

beforeEach(() => {
  origToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token-not-real';
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (origToken === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = origToken;
  for (const res of openResponses.splice(0)) res.destroy();
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function startStallingServer(): Promise<string> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    // Partial body, then silence: the response never ends.
    res.write('{"five_hour":');
    openResponses.push(res);
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api/oauth/usage`;
}

describe('fetchClaudeUsageApi deadline', () => {
  it('settles as a timeout when the server sends headers then stalls the body', async () => {
    const localUrl = await startStallingServer();
    vi.stubGlobal('fetch', (_url: unknown, init?: RequestInit) => realFetch(localUrl, init));

    const { fetchClaudeUsageApi } = await import('../src/core/fabric/usage-api.js');
    const started = Date.now();
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      fetchClaudeUsageApi().then((r) => ({ settled: true as const, r })),
      new Promise<{ settled: false }>((resolve) => {
        guard = setTimeout(() => resolve({ settled: false }), 8_000);
      }),
    ]);
    clearTimeout(guard);

    expect(outcome.settled).toBe(true);
    if (outcome.settled) expect(outcome.r).toBeNull();
    // The deadline is 3s; allow scheduling slack but stay well under the guard.
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});
