import { describe, expect, it } from 'vitest';
import { aboutUpdateLines } from './about-update-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const status: UpdateServerStatus = {
  v: 1, sourceState: 'healthy', installedVersion: '3.30.0', headSha: 'abcdef123456',
  headAt: '2026-10-31T10:00:00Z', originSha: '123456789abc', branch: 'master',
  behind: 0, ahead: 0, dirty: false, lastFetchAt: '2026-10-31T11:55:00Z',
  processStartedAt: '2026-10-30T12:00:00Z', uptimeSeconds: 90061, canFastForward: false,
};

describe('aboutUpdateLines', () => {
  it('describes a current checkout and its commit and process details', () => {
    expect(aboutUpdateLines(status, now)).toEqual({
      tone: 'current', headline: 'Up to date with origin/master', rows: [
        { label: 'Running commit', value: 'abcdef1', mono: true },
        { label: 'Committed', value: '2 hours ago' },
        { label: 'Origin', value: '1234567', mono: true },
        { label: 'Last fetch', value: '5 minutes ago' },
        { label: 'Process up', value: '1 day' },
      ],
    });
  });
  it('reports a fast-forwardable update and singular commit', () => {
    expect(aboutUpdateLines({ ...status, behind: 1, canFastForward: true }, now)).toMatchObject({
      tone: 'behind', headline: '1 commit behind origin/master · Fast-forward ready',
    });
  });
  it('explains when local changes block an update', () => {
    expect(aboutUpdateLines({ ...status, behind: 3, dirty: true, canFastForward: false }, now)).toMatchObject({
      tone: 'behind', headline: '3 commits behind origin/master · Needs a manual update (local changes)',
    });
  });
  it('does not claim a fast-forward is ready when another condition blocks it', () => {
    expect(aboutUpdateLines({ ...status, behind: 3, ahead: 1 }, now).headline).toContain('Fast-forward unavailable');
  });
  it('handles an older build', () => {
    expect(aboutUpdateLines({ kind: 'notInBuild' }, now)).toEqual({ tone: 'notInBuild', headline: 'Self-update status is not in this build.', rows: [] });
  });
  it('omits null-valued rows', () => {
    expect(aboutUpdateLines({ ...status, headSha: null, headAt: null, originSha: null, lastFetchAt: null, uptimeSeconds: null }, now).rows).toEqual([]);
  });
  it('uses the supplied time for relative text including future dates', () => {
    const sample = { ...status, headAt: '2026-10-31T12:00:30Z', lastFetchAt: '2026-10-31T11:59:30Z', uptimeSeconds: 0 };
    expect(aboutUpdateLines(sample, now).rows).toContainEqual({ label: 'Committed', value: 'in 30 seconds' });
    expect(aboutUpdateLines(sample, now).rows).toContainEqual({ label: 'Last fetch', value: '30 seconds ago' });
    expect(aboutUpdateLines(sample, now + 60_000).rows).toContainEqual({ label: 'Committed', value: '30 seconds ago' });
    expect(aboutUpdateLines(sample, now).rows).toContainEqual({ label: 'Process up', value: '0 seconds' });
  });
  it('does not claim current status when the source or cleanliness is unknown', () => {
    expect(aboutUpdateLines({ ...status, sourceState: 'unavailable' }, now).tone).toBe('unknown');
    expect(aboutUpdateLines({ ...status, dirty: null }, now).tone).toBe('unknown');
    expect(aboutUpdateLines(null, now).tone).toBe('unknown');
  });
});
