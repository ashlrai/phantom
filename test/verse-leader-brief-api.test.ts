import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLeaderBriefApi, LEADER_BRIEF_CACHE_MS, LEADER_BRIEF_SCHEMA, VERSE_LEADER_BRIEF_PATH as PATH } from '../src/core/verse/leader-brief-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function call(api: ReturnType<typeof createLeaderBriefApi>, opts: { path?: string; method?: string; allowDispatch?: boolean } = {}) {
  const { path = PATH, method = 'GET', allowDispatch = true } = opts;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const BRIEF = 'Morning leader brief\nShipped (last 12h): none\nQuota: claude weeklyPct=80%';

describe('GET /api/verse/leader/brief', () => {
  it('serves the schema and the brief with its heading replaced', async () => {
    const brief = vi.fn(async () => BRIEF);
    const at = new Date('2026-11-09T12:00:00Z');
    const { handled, status, body } = await call(createLeaderBriefApi({ runsDir: '/runs', brief, now: () => at }));
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(body).toEqual({ schema: LEADER_BRIEF_SCHEMA, at: at.toISOString(), text: 'Phantom status\nShipped (last 12h): none\nQuota: claude weeklyPct=80%' });
    expect(brief).toHaveBeenCalledWith('/runs', at);
  });

  it('caches within 60 s, then reads again', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const brief = vi.fn(async () => BRIEF);
    const api = createLeaderBriefApi({ runsDir: '/runs', brief, now: () => new Date(t) });
    await call(api);
    t += LEADER_BRIEF_CACHE_MS - 1;
    const cached = await call(api);
    expect(brief).toHaveBeenCalledTimes(1);
    expect(cached.body.at).toBe('2026-11-09T12:00:00.000Z');
    t += 1;
    await call(api);
    expect(brief).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent requests', async () => {
    const brief = vi.fn(async () => BRIEF);
    const api = createLeaderBriefApi({ runsDir: '/runs', brief });
    await Promise.all([call(api), call(api), call(api)]);
    expect(brief).toHaveBeenCalledTimes(1);
  });

  it('answers 200 with the unavailable shape when the brief throws or is empty', async () => {
    const at = new Date('2026-11-09T12:00:00Z');
    for (const brief of [async () => { throw new Error('boom /secret/path'); }, async () => '  ']) {
      const { status, body } = await call(createLeaderBriefApi({ runsDir: '/runs', brief, now: () => at }));
      expect(status).toBe(200);
      expect(body).toEqual({ schema: LEADER_BRIEF_SCHEMA, at: at.toISOString(), text: null, reason: 'unavailable' });
    }
  });

  it('is read only and dispatch-session only', async () => {
    const brief = vi.fn(async () => BRIEF);
    const api = createLeaderBriefApi({ runsDir: '/runs', brief });
    expect((await call(api, { method: 'POST' })).status).toBe(405);
    expect((await call(api, { allowDispatch: false })).status).toBe(404);
    expect(brief).not.toHaveBeenCalled();
  });

  it('leaves other paths unhandled', async () => {
    const api = createLeaderBriefApi({ runsDir: '/runs', brief: async () => BRIEF });
    for (const path of ['/api/verse/leader', '/api/verse/leader/thread', `${PATH}/x`]) {
      const r = await call(api, { path });
      expect(r.handled).toBe(false);
      expect(r.status).toBe(0);
    }
  });
});
