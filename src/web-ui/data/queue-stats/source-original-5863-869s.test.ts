import { describe, expect, it } from 'vitest';
import { estimateQueueStats } from '../../../core/queue/stats.js';
import { QUEUE_STATS_NORMAL } from './fixtures.js';
import { commandQueueStatsSource } from './source.js';

describe('command queue stats producer contract', () => {
  it('refuses when no producer is wired', async () => {
    expect(await commandQueueStatsSource().load()).toEqual({ ok: false, error: 'no queue.stats.v1 producer is wired yet' });
  });

  it('does not echo invalid producer output', async () => {
    const result = await commandQueueStatsSource(async () => 'fake private payload {').load();
    expect(result).toEqual({ ok: false, error: 'queue stats producer output was not valid JSON' });
  });

  it('accepts a valid queue.stats.v1 fixture', async () => {
    expect(await commandQueueStatsSource(async () => JSON.stringify(QUEUE_STATS_NORMAL)).load()).toEqual({
      ok: true, value: QUEUE_STATS_NORMAL,
    });
  });

  it('rejects the actual queue journal statistics producer output', async () => {
    const journalStats = estimateQueueStats([{ id: 'example', station: 'claimed', pool: 'local', arrivedAt: 1000 }], 2000);
    expect(await commandQueueStatsSource(async () => JSON.stringify(journalStats)).load()).toEqual({
      ok: false, error: 'schema must be queue.stats.v1',
    });
  });
});
