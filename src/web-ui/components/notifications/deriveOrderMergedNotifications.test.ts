import { describe, expect, it } from 'vitest';
import type { OrderTraceJob, OrderTraceV1 } from '../../routes/verse/fleet-inbox/order-trace-model.js';
import { deriveOrderMergedNotifications } from './deriveOrderMergedNotifications.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const job = (id: string, state: OrderTraceJob['state'], url: string | null = null): OrderTraceJob => ({ id, lane: null, state, url });
const trace = (jobs: OrderTraceJob[], at = '2026-11-01T05:08:00Z', key = '11-01 00:08'): OrderTraceV1 => ({
  v: 1, generatedAt: at, sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at, source: 'MASON-INBOX', key, jobs }],
});
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;

describe('deriveOrderMergedNotifications', () => {
  it('returns none without a trace or a merged job', () => {
    expect(deriveOrderMergedNotifications(null, NOW)).toEqual([]);
    expect(deriveOrderMergedNotifications(trace([job('a', 'queued'), job('b', 'published', pr(1))]), NOW)).toEqual([]);
  });

  it('reports partial and full merges', () => {
    const [partial] = deriveOrderMergedNotifications(trace([job('a', 'merged', pr(7)), job('b', 'launched'), job('c', 'queued')]), NOW);
    expect(partial).toMatchObject({ id: 'order-merged:11-01 00:08', category: 'fleet', severity: 'info',
      title: 'Your 11-01 00:08 order: 1 of 3 merged', detail: 'merged #7, running, queued',
      ts: '2026-11-01T05:08:00Z', actionLabel: 'Open inbox', actionHref: expect.stringContaining('fleet-inbox') });
    const [all] = deriveOrderMergedNotifications(trace([job('a', 'merged'), job('b', 'merged'), job('c', 'merged')]), NOW);
    expect(all!.title).toBe('Your 11-01 00:08 order: All 3 merged');
  });

  it('caps the detail at three jobs', () => {
    const jobs = ['a', 'b', 'c', 'd', 'e'].map(id => job(id, 'merged'));
    expect(deriveOrderMergedNotifications(trace(jobs), NOW)[0]!.detail).toBe('merged, merged, merged and 2 more');
  });

  it('ignores orders older than 48 h', () => {
    expect(deriveOrderMergedNotifications(trace([job('a', 'merged')], '2026-10-30T11:00:00Z'), NOW)).toEqual([]);
  });

  it('keeps the same id across readings', () => {
    const first = deriveOrderMergedNotifications(trace([job('a', 'merged'), job('b', 'launched')]), NOW);
    const second = deriveOrderMergedNotifications(trace([job('a', 'merged'), job('b', 'merged')]), NOW + 60_000);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.title).toContain('All 2');
  });

  it('never exposes non-github or credentialed job URLs', () => {
    const bad = ['https://evil.example/pull/9', 'https://someone@github.com/ashlrai/phantom/pull/9', 'http://github.com/a/b/pull/9'];
    const out = deriveOrderMergedNotifications(trace([job('a', 'merged', bad[0]), job('b', 'merged', bad[1]), job('c', 'merged', bad[2])]), NOW);
    const text = JSON.stringify(out);
    for (const url of bad) expect(text).not.toContain(url);
    expect(text).not.toContain('someone');
    expect(text).not.toContain('#9');
  });
});
