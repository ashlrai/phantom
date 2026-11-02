import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from './mobile.test-support.js';
import { narrowInboxTail } from './inbox-tail-query.js';

afterEach(() => vi.unstubAllGlobals());

describe('inbox tail', () => {
  it('narrows only the inbox and rejects malformed entries', () => {
    expect(narrowInboxTail({ workers: [], inbox: [{ at: 'now', source: 'phone', text: 'hello', extra: true }] }))
      .toEqual([{ at: 'now', source: 'phone', text: 'hello' }]);
    for (const value of [{}, { inbox: null }, { inbox: [{ at: 1, source: 'phone', text: 'hello' }] }]) {
      expect(() => narrowInboxTail(value)).toThrow('malformed');
    }
  });

  it('memoizes a missing route', async () => {
    vi.resetModules();
    const { inboxTailQuery } = await import('./inbox-tail-query.js');
    const stub = stubFetch({ 'GET /api/verse/fleet/runs': () => json({ error: 'not found' }, 404) });
    await expect(inboxTailQuery.fetch()).rejects.toMatchObject({ status: 404 });
    await expect(inboxTailQuery.fetch()).rejects.toMatchObject({ status: 404 });
    expect(stub.calls).toHaveLength(1);
  });
});
