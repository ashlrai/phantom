import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createFleetReviewPickApi, VERSE_FLEET_REVIEW_PICK_PATH as PATH } from '../src/core/verse/fleet-review-pick-api.js';
import { createFleetWorkBoardApi } from '../src/core/verse/fleet-work-board-api.js';
import { VERSE_FLEET_ORDER_STATE_PATH } from '../src/core/verse/fleet-order-state-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { ReviewPickReport } from '../src/core/fleet/review-pick.js';

function report(): ReviewPickReport {
  return {
    schema: 'fleet.review-pick.v1', as_of: '2026-11-14T18:00:00.000Z', repo: 'example/phantom',
    source: { prs: 'read', claims: { 'claimed-tsv': 'read', 'bus-work-claims': 'read',
      coordination: 'read', 'live-workers': 'read' }, unavailable: [] },
    picked: { repo: 'example/phantom', pr: 42, head: 'review/fake', head_sha: 'a'.repeat(40),
      title: 'Fake review task', owner: 'none', reason: 'no live owner' },
    reason: 'no live owner', skipped: [], unowned_candidates: 1,
  };
}

async function call(api: ApiModule, method = 'GET', url = `${PATH}?repo=example/phantom`) {
  let status = 0;
  let text = '';
  const end = vi.fn((body: string) => { text = body; });
  const res = { writeHead(code: number) { status = code; return this; }, end } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url } as IncomingMessage, res, url.split('?')[0]!, method);
  expect(text).not.toMatch(/\/Users\/|\/(?:tmp|private|etc|opt|var|home)\//);
  return { handled, status, text, body: text ? JSON.parse(text) : null, end };
}

describe('fleet review-pick HTTP boundary', () => {
  it('serves the healthy pick and forwards only the validated repo', async () => {
    const read = vi.fn(async () => report());
    const r = await call(createFleetReviewPickApi({ read }), 'GET',
      `${PATH}?repo=example/phantom&root=/tmp/fake&path=/etc/fake&runsDir=/tmp/fake`);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(report());
    expect(read).toHaveBeenCalledExactlyOnceWith({ repo: 'example/phantom' });
  });

  it('defaults the repo and ignores unrelated routes without a read', async () => {
    const read = vi.fn(async () => report());
    const api = createFleetReviewPickApi({ read });
    await call(api, 'GET', PATH);
    expect(read).toHaveBeenCalledExactlyOnceWith({ repo: 'ashlrai/phantom' });
    expect((await call(api, 'GET', '/api/verse/other')).handled).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('preserves unavailable ownership evidence without inventing a pick', async () => {
    const unavailable = report();
    unavailable.picked = null;
    unavailable.reason = 'ownership source unavailable';
    unavailable.source.claims.coordination = 'unavailable';
    unavailable.source.unavailable = ['coordination'];
    const r = await call(createFleetReviewPickApi({ read: async () => unavailable }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual(unavailable);
  });

  it('rejects invalid repos and non-GET requests before reading', async () => {
    const read = vi.fn(async () => report());
    const api = createFleetReviewPickApi({ read });
    for (const repo of ['', '../fake', '/tmp/fake', 'example/phantom/extra', 'example/has space']) {
      const r = await call(api, 'GET', `${PATH}?repo=${encodeURIComponent(repo)}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid repo' });
    }
    const post = await call(api, 'POST');
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: 'method not allowed' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)('degrades a reader %s without returning diagnostics', async (failure) => {
    const read = vi.fn(() => {
      const error = new Error('fake command gh --repo /Users/fake/private /etc/fake');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    const r = await call(createFleetReviewPickApi({ read }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'fleet.review-pick.v1', picked: null,
      reason: 'review-pick read unavailable', source: { prs: 'unavailable' } });
    expect(r.text).not.toMatch(/fake command|gh --repo/);
  });

  it('bounds a hung read and ignores a pick arriving after the deadline', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: ReviewPickReport) => void;
      const api = createFleetReviewPickApi({ timeoutMs: 5,
        read: () => new Promise(resolve => { finish = resolve; }) });
      const pending = call(api);
      await vi.advanceTimersByTimeAsync(5);
      const r = await pending;
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ picked: null, reason: 'review-pick read unavailable' });
      finish(report());
      await vi.runAllTimersAsync();
      expect(r.end).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('chains review-pick and orders to their respective injected handlers', async () => {
    const read = vi.fn(async () => report());
    const reviewPick = vi.fn(createFleetReviewPickApi({ read }));
    const orders = vi.fn<ApiModule>(async () => true);
    const api = createFleetWorkBoardApi({ reviewPick, orders,
      read: () => { throw new Error('board must not read'); } });
    expect((await call(api)).body.picked.pr).toBe(42);
    expect(reviewPick).toHaveBeenCalledTimes(1);
    expect(orders).not.toHaveBeenCalled();
    expect((await call(api, 'GET', VERSE_FLEET_ORDER_STATE_PATH)).handled).toBe(true);
    expect(orders).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
