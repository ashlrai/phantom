/**
 * RQ-PHX-LEADERPUSHRESTORE10SRU1 — recovered #4359 leader-thread push,
 * end to end at the server boundary: an EXTERNAL process appending to (or
 * atomically rotating) the Leader thread file must produce a `leader-thread`
 * SSE event on the authenticated /api/events stream without any poll.
 *
 * Real temporary disk writes only — no fs.watch injection — so this proves
 * the directory watch survives atomic rename rotation, that two SSE clients
 * share the one watcher, that closing one preserves the other, and that the
 * event carries a timestamp and nothing else (never message bodies).
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { handleApi, drainSseConnections } from '../src/core/web/api.js';
import { leaderThreadPath } from '../src/core/vision/leader-thread.js';

const MARKER = 'LEADER-PUSH-RECOVERY-10SRU1-PRIVATE-BODY';
const THREAD_PATH = leaderThreadPath();
const THREAD_DIR = dirname(THREAD_PATH);

const cfg = { version: 1, roots: [], telemetry: {}, tools: {}, models: { providerChain: [] } } as never;
const session = { id: 'leader-push-recovery', expiresAt: Date.now() + 3_600_000 };

interface SseClient {
  req: IncomingMessage;
  chunks: string[];
  events: () => string[];
  leaderThreadPayloads: () => Record<string, unknown>[];
  close: () => void;
}

function openSse(url = '/api/events?topics=leader-thread'): SseClient {
  const req = new EventEmitter() as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: '127.0.0.1' };
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; return this; },
    setHeader() {},
    write(chunk: string) { chunks.push(chunk); return true; },
    end(chunk?: string) { if (chunk) chunks.push(chunk); this.writableEnded = true; },
  }) as unknown as ServerResponse;
  void handleApi(req, res, cfg, { token: 't', allowDispatch: false, readSession: session });
  const events = () => chunks.join('').split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7));
  const leaderThreadPayloads = () =>
    chunks.join('').split('\n\n')
      .filter((block) => block.startsWith('event: leader-thread\n'))
      .map((block) => JSON.parse(block.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as Record<string, unknown>);
  return { req, chunks, events, leaderThreadPayloads, close: () => req.emit('close') };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const countLeaderThread = (c: SseClient) => c.events().filter((e) => e === 'leader-thread').length;

function appendThreadLine(n: number): void {
  writeFileSync(THREAD_PATH, `${JSON.stringify({ v: 1, n, body: `${MARKER}-${n}` })}\n`, { flag: 'a' });
}

beforeAll(() => {
  mkdirSync(THREAD_DIR, { recursive: true });
  writeFileSync(THREAD_PATH, `${JSON.stringify({ v: 1, n: 0, body: MARKER })}\n`);
});

afterEach(() => {
  drainSseConnections();
});

describe('leader-thread push recovery (real disk writes)', () => {
  it('external append produces a timestamp-only leader-thread event', { timeout: 20_000 }, async () => {
    const client = openSse();
    expect(countLeaderThread(client)).toBe(0);

    appendThreadLine(1);
    await waitFor(() => countLeaderThread(client) === 1, 'leader-thread event after append');

    const payloads = client.leaderThreadPayloads();
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!)).toEqual(['at']);
    expect(typeof payloads[0]!['at']).toBe('string');
    expect(client.chunks.join('')).not.toContain(MARKER);
    client.close();
  });

  it('atomic rotation and the rotated sibling still invalidate', { timeout: 20_000 }, async () => {
    const client = openSse();
    appendThreadLine(2);
    await waitFor(() => countLeaderThread(client) === 1, 'event after append');

    // Atomic replace: write a temp file then rename over thread.jsonl — a watch
    // on the file itself would lose this; the directory watch must not.
    const rotated = `${THREAD_PATH}.new-${process.pid}`;
    writeFileSync(rotated, `${JSON.stringify({ v: 1, n: 3, body: `${MARKER}-rotated` })}\n`);
    renameSync(rotated, THREAD_PATH);
    await waitFor(() => countLeaderThread(client) === 2, 'event after atomic rotation');

    // The rotated archive sibling is also a watched name.
    writeFileSync(join(THREAD_DIR, 'thread.1.jsonl'), `${JSON.stringify({ v: 1, n: 4 })}\n`);
    await waitFor(() => countLeaderThread(client) === 3, 'event after thread.1.jsonl write');

    expect(client.chunks.join('')).not.toContain(MARKER);
    client.close();
  });

  it('two clients share one watcher; closing one preserves the other', { timeout: 20_000 }, async () => {
    const a = openSse();
    const b = openSse();
    appendThreadLine(5);
    await waitFor(() => countLeaderThread(a) === 1 && countLeaderThread(b) === 1, 'both clients notified');

    a.close();
    const aCount = countLeaderThread(a);
    appendThreadLine(6);
    await waitFor(() => countLeaderThread(b) === 2, 'surviving client still notified');
    // Give the closed client a debounce window to prove it stays silent.
    await new Promise((r) => setTimeout(r, 400));
    expect(countLeaderThread(a)).toBe(aCount);

    b.close();
    // Both released: a fresh connection must still receive (watcher map clean).
    const c = openSse();
    appendThreadLine(7);
    await waitFor(() => countLeaderThread(c) === 1, 'reconnected client notified');
    c.close();
  });

  it('a stream without the leader-thread topic does not subscribe', { timeout: 20_000 }, async () => {
    const control = openSse('/api/events?topics=inbox');
    appendThreadLine(8);
    await waitFor(() => countLeaderThread(control) === 0 && control.events().length > 0, 'control stream up', 8_000);
    await new Promise((r) => setTimeout(r, 600));
    expect(countLeaderThread(control)).toBe(0);
    control.close();
  });
});
