/**
 * test/radar-local-bench-redirect.test.ts — the loopback guarantee holds past
 * the first hop.
 *
 * The bench validates that its base URL is loopback before any fetch, but the
 * fetch default (redirect:'follow') let a validated endpoint answer a redirect
 * and have undici re-POST the synthetic bench body to whatever origin Location
 * named — a second hop nothing re-validated. The transport now passes
 * redirect:'error', so any redirect reply is a transport failure instead.
 *
 * Real IO: two loopback HTTP servers per case — one always redirects to the
 * other, and the second listener must never see a request.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_BENCH_SCHEMA,
  parseBenchFixture,
  scoreSuite,
  type BenchSuiteFixture,
} from '../src/core/radar/local-bench.js';

const oneCaseFixture = (): BenchSuiteFixture =>
  parseBenchFixture({
    schema: LOCAL_BENCH_SCHEMA,
    suite: 'triage',
    labels: ['skip', 'work:fleet'],
    instruction: 'Answer with exactly one label.',
    cases: [{ id: 'r1', input: 'synthetic bench prompt', expected: 'skip' }],
  });

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const close = (server: Server): Promise<void> => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
};

describe('redirect refusal — a validated endpoint cannot bounce the body elsewhere', () => {
  // Regression for the reviewed fix: with the fetch default (redirect:'follow')
  // a 307/308 re-POSTs the bench body to whatever origin Location names.
  it.each([301, 302, 303, 307, 308])('a %i reply never reaches the second listener', async (status) => {
    let targetRequests = 0;
    let targetBodyBytes = 0;
    const target = createServer((req, res) => {
      targetRequests += 1;
      req.on('data', (chunk: Buffer) => { targetBodyBytes += chunk.length; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'skip' } }] }));
      });
    });
    const targetPort = await listen(target);
    const redirector = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { location: `http://127.0.0.1:${targetPort}/v1/chat/completions` });
        res.end();
      });
    });
    const originPort = await listen(redirector);
    try {
      const scored = await scoreSuite(fetch, `http://127.0.0.1:${originPort}`, 'm:1b', oneCaseFixture(), 5_000);
      expect(scored).toHaveLength(1);
      expect(scored[0]!.error).toBe('transport');
      expect(scored[0]!.answered).toBeNull();
      expect(targetRequests).toBe(0);
      expect(targetBodyBytes).toBe(0);
    } finally {
      await Promise.all([close(redirector), close(target)]);
    }
  });
});
