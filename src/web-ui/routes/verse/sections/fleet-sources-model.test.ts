import { describe, expect, it } from 'vitest';
import { readFleetSources } from './fleet-sources-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const sources = { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' };

describe('readFleetSources', () => {
  it('reads healthy sources and freshness', () => {
    const result = readFleetSources({ sources, generatedAt: new Date(now - 4000).toISOString(), claudeLane: 'claude-cli' }, now);
    expect(result.rows.map(row => [row.word, row.tone, row.remedy])).toEqual(Array(5).fill(['Live', 'success', null]));
    expect(result.freshness).toEqual({ ageSeconds: 4, stale: false });
    expect(result.claudeLane).toBe('claude-cli');
  });
  it('explains individual source failures', () => {
    const rows = readFleetSources({ sources: { ...sources, merges: 'degraded', codex: 'missing', inbox: 'not-landed', runsDir: 'missing', workers: 'degraded' } }, now).rows;
    expect(rows.map(row => row.remedy)).toEqual([
      'The runs directory was not found on this Mac; start the dispatcher once to create it.',
      'Process listing failed; the sidecar could not run ps.', 'Not part of this build.',
      'No personal Codex session logs found.', 'GitHub CLI not available or not signed in; merges in the last hour cannot be counted.',
    ]);
    expect(rows.map(row => row.tone)).toEqual(['danger', 'warning', 'neutral', 'danger', 'warning']);
  });
  it('handles stale, invalid and unknown input without inventing values or exposing paths', () => {
    expect(readFleetSources({ generatedAt: new Date(now - 45000).toISOString() }, now).freshness).toEqual({ ageSeconds: 45, stale: true });
    expect(readFleetSources({ generatedAt: 'invalid', claudeLane: '/Users/private' }, now)).toMatchObject({ freshness: { ageSeconds: null, stale: false }, claudeLane: null });
    expect(readFleetSources(null, now).rows.every(row => row.state === 'unknown' && row.word === '—')).toBe(true);
  });
});
