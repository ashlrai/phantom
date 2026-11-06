import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../../routes/verse/shell/deep-link.js';
import { severityToTone } from './types.js';
import { deriveMergeStallNotification as derive } from './deriveMergeStallNotification.js';

const now = Date.parse('2026-11-01T04:10:00Z');
const publishes = [5, 10, 15, 20].map((minutes, i) => ({
  job: `job-${i + 1}`, lane: 'codex', url: null, at: new Date(now - minutes * 60_000).toISOString(),
}));
const snapshot = { sources: { merges: 'healthy' }, mergesLastHour: { count: 0 }, publishesLastHour: publishes };

describe('deriveMergeStallNotification', () => {
  it('reports the publish count, up to three job ages, and links to merges with danger tone', () => {
    const result = derive(snapshot, now);
    expect(result).toHaveLength(1);
    const notification = result[0]!;
    expect(notification).toMatchObject({ category: 'fleet', severity: 'critical',
      title: 'Merge gate stalled: 4 published, 0 merged in the last hour',
      detail: 'job-1 (5m ago) · job-2 (10m ago) · job-3 (15m ago)', actionLabel: 'Open merges' });
    expect(notification.detail).not.toContain('job-4');
    expect(severityToTone(notification.severity)).toBe('danger');
    expect(parseDeepLink(new URL(notification.actionHref!).search)).toEqual({ paneId: 'fleet-merges', sessionId: null });
  });

  it.each([
    { ...snapshot, mergesLastHour: { count: 2 } },
    { ...snapshot, mergesLastHour: { count: null } },
    { ...snapshot, sources: { merges: 'degraded' } },
    { ...snapshot, publishesLastHour: publishes.slice(0, 2) },
    null, {},
  ])('stays silent without the required evidence', (data) => {
    expect(derive(data, now)).toEqual([]);
  });

  it('deduplicates within the hour and raises again in the next hour', () => {
    expect(derive(snapshot, now)[0]?.id).toBe(derive(snapshot, now + 30 * 60_000)[0]?.id);
    expect(derive(snapshot, now)[0]?.id).not.toBe(derive(snapshot, now + 60 * 60_000)[0]?.id);
  });
});
