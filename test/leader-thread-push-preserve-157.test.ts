/**
 * Preservation evidence for recovered PR #5052 (source ae1e87ce): a real append
 * to the Leader thread file, seen through the SSE stream's `leader-thread`
 * topic, produces an invalidation that carries NO message content. The text is
 * fetched afterwards through the existing authenticated thread route.
 * Runs against the relocated test HOME only (test/setup/home.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { leaderThreadPath, listThread, postLeaderMessage } from '../src/core/vision/leader-thread.js';

const api = await import('../src/core/web/api.js');

function makeReq(url: string): IncomingMessage {
  return {
    url, method: 'GET', headers: { host: '127.0.0.1' },
    on() { return this; }, once() { return this; },
  } as unknown as IncomingMessage;
}

function makeSseRes() {
  const chunks: string[] = [];
  const res = {
    headersSent: false, writableEnded: false,
    writeHead() { return this; }, setHeader() {},
    write(chunk: string) { chunks.push(chunk); return true; },
    end() {}, on() { return this; }, once() { return this; },
  };
  return { res: res as unknown as ServerResponse, text: () => chunks.join('') };
}

const session = { id: 'preserve-157', expiresAt: Date.now() + 3_600_000 };
const cfg = { version: 1, roots: [], telemetry: {}, tools: {}, models: { providerChain: [] } } as never;

afterEach(() => { api.drainSseConnections(); });

describe('leader-thread SSE invalidation (recovered #5052)', () => {
  it('is a subscribable topic', () => {
    expect(api.SSE_TOPICS).toContain('leader-thread');
    expect([...api.parseSseTopics('leader-thread')]).toEqual(['leader-thread']);
  });

  it('fires on a real external append and carries no message text', async () => {
    const secret = 'PRESERVE157-BODY-MUST-NOT-LEAK';
    const { res, text } = makeSseRes();
    // Make sure the directory exists so fs.watch arms on it.
    postLeaderMessage({ channel: 'verse', kind: 'message', text: 'seed' } as never);
    await api.handleApi(makeReq('/api/events?topics=leader-thread'), res, cfg, {
      token: 't', allowDispatch: false, readSession: session,
    } as never);

    // A second "process" appends; repeat because a real watch can arm late.
    await vi_waitFor(() => /event: leader-thread/.test(text()), () => {
      postLeaderMessage({ channel: 'verse', kind: 'message', text: secret } as never);
    });

    const frame = text().split('\n\n').find((f) => f.startsWith('event: leader-thread'))!;
    const data = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['at']);
    expect(text()).not.toContain(secret);
    expect(leaderThreadPath()).toContain('thread.jsonl');
    // The body is available only through the normal read path.
    expect(listThread({}).some((m) => m.text === secret)).toBe(true);
  }, 20_000);
});

async function vi_waitFor(cond: () => boolean, stimulus: () => void, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    if (cond()) return;
    if (tick++ % 8 === 0) stimulus();
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for leader-thread event');
}
