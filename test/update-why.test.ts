import { describe, expect, it } from 'vitest';
import { updateWhy } from '../src/core/desktop/update-why.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe('desktop update why', () => {
  it('distinguishes an empty release from a missing feed', async () => {
    for (const [assets, reason] of [[[], 'no-assets'], [[{}], 'feed-404']] as const) {
      const fetcher = (async (url: string | URL | Request) => String(url).includes('api.github.com') ? json({ assets }) : json({}, 404)) as typeof fetch;
      expect((await updateWhy('1.0.0', fetcher)).reason).toBe(reason);
    }
  });
  it('reports feed version and current or available status without fetching artifacts', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => { calls.push(String(url)); return json({ version: '2.0.0' }); }) as typeof fetch;
    expect(await updateWhy('2.0.0', fetcher)).toMatchObject({ feedVersion: '2.0.0', reason: 'already-current' });
    expect(await updateWhy('1.0.0', fetcher)).toMatchObject({ feedVersion: '2.0.0', reason: 'available' });
    expect(calls.every(url => url.endsWith('/latest.json'))).toBe(true);
  });
  it('reports offline as unknown', async () => {
    const fetcher = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await updateWhy('1.0.0', fetcher)).toMatchObject({ feedVersion: null, reason: 'unknown' });
  });
});
