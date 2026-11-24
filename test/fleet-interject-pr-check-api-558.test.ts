/** GET /api/verse/fleet/control/interject-pr-check: GitHub second reader for the interject box. Fake gh only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  createFleetInterjectPrCheckApi, VERSE_FLEET_INTERJECT_PR_CHECK_PATH as PATH,
} from '../src/core/verse/fleet-interject-pr-check-api.js';

const MERGED = { state: 'closed', merged: true, merged_at: '2026-11-14T17:00:00Z', number: 11, base: { repo: { full_name: 'ashlrai/phantom' } } };

async function call(api: ApiModule, method = 'GET', url = `${PATH}?pr=11`) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url } as IncomingMessage, res, url.split('?')[0]!, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}
const ghOf = (over: Record<number, unknown> = {}) => vi.fn(async (args: string[]) => {
  const pr = Number(args.at(-1)!.split('/').pop());
  return JSON.stringify(over[pr] ?? { ...MERGED, number: pr });
});

describe('interject pr check route', () => {
  it('reports merged, open and closed-unmerged', async () => {
    const gh = ghOf({
      12: { state: 'open', merged: false, merged_at: null, number: 12 },
      13: { state: 'closed', merged: false, merged_at: null, number: 13 },
    });
    const r = await call(createFleetInterjectPrCheckApi({ gh }), 'GET', `${PATH}?pr=11&pr=12&pr=13`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, authority: 'none' });
    expect(r.body.items).toEqual([
      { pr: 11, verdict: 'merged', mergedAt: '2026-11-14T17:00:00Z' },
      { pr: 12, verdict: 'open', mergedAt: null },
      { pr: 13, verdict: 'closed-unmerged', mergedAt: null },
    ]);
    expect(gh.mock.calls[0]![0]).toContain('repos/ashlrai/phantom/pulls/11');
  });

  it('turns an identity mismatch into unknown', async () => {
    const wrongNumber = await call(createFleetInterjectPrCheckApi({ gh: ghOf({ 11: { ...MERGED, number: 99 } }) }));
    expect(wrongNumber.body.items[0]).toMatchObject({ verdict: 'unknown', reason: 'invalid-response-identity' });
    const wrongRepo = await call(createFleetInterjectPrCheckApi({ gh: ghOf({ 11: { ...MERGED, base: { repo: { full_name: 'other/repo' } } } }) }));
    expect(wrongRepo.body.items[0]).toMatchObject({ verdict: 'unknown', reason: 'invalid-response-identity' });
  });

  it('never echoes gh error text', async () => {
    const gh = vi.fn(async () => { throw new Error('SECRET-TOKEN-xyz boom'); });
    const r = await call(createFleetInterjectPrCheckApi({ gh }));
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toEqual({ pr: 11, verdict: 'unknown', mergedAt: null, reason: 'read-failed' });
    expect(r.text).not.toContain('SECRET');
    expect(r.text).not.toContain('boom');
  });

  it('rejects bad queries with 400', async () => {
    const gh = ghOf();
    const api = createFleetInterjectPrCheckApi({ gh });
    for (const url of [PATH, `${PATH}?pr=0`, `${PATH}?pr=-1`, `${PATH}?pr=abc`, `${PATH}?pr=1.5`, `${PATH}?pr=11&repo=x/y`,
      `${PATH}?pr=99999999999999999999`, `${PATH}?pr=`, `${PATH}?id=11`]) {
      expect((await call(api, 'GET', url)).status, url).toBe(400);
    }
    expect(gh).not.toHaveBeenCalled();
  });

  it('rejects six prs with 400 and accepts five', async () => {
    const api = createFleetInterjectPrCheckApi({ gh: ghOf() });
    expect((await call(api, 'GET', `${PATH}?${[1, 2, 3, 4, 5, 6].map(n => `pr=${n}`).join('&')}`)).status).toBe(400);
    expect((await call(api, 'GET', `${PATH}?${[1, 2, 3, 4, 5].map(n => `pr=${n}`).join('&')}`)).status).toBe(200);
  });

  it('answers 405 to non-GET and ignores other paths', async () => {
    const api = createFleetInterjectPrCheckApi({ gh: ghOf() });
    expect((await call(api, 'POST')).status).toBe(405);
    expect((await call(api, 'GET', '/api/verse/fleet/control/other')).handled).toBe(false);
  });

  it('reuses a read inside 60 s and re-reads after', async () => {
    const gh = ghOf();
    const clock = { ms: Date.parse('2026-11-14T18:00:00Z') };
    const api = createFleetInterjectPrCheckApi({ gh, now: () => clock.ms });
    await call(api); clock.ms += 59_000; await call(api);
    expect(gh).toHaveBeenCalledTimes(1);
    clock.ms += 2_000; await call(api);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it('marks unread prs unknown/deadline once the total deadline passes', async () => {
    const gh = vi.fn(() => new Promise<string>(() => { /* never settles */ }));
    const r = await call(createFleetInterjectPrCheckApi({ gh, timeoutMs: 20 }), 'GET', `${PATH}?pr=11&pr=12`);
    expect(r.body.items.map((i: { reason: string }) => i.reason)).toEqual(['deadline', 'deadline']);
  });
});
