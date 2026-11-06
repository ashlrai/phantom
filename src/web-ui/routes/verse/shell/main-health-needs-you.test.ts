import { describe, expect, it } from 'vitest';
import { deriveMainHealthNeedsYou } from './main-health-needs-you.js';
import type { MainHealthData } from './main-health-query.js';

const repo: MainHealthData['repos'][number] = { repo: 'phantom', branch: 'master', sha: 'abcdef0123', state: 'red',
  checkedAt: '2026-11-01T00:00:00Z', failingCheck: 'build', fixJobs: [], nightlyRed: null };
const data: MainHealthData = { v: 1, generatedAt: '2026-11-01T00:00:00Z', source: 'ok', statusAt: null,
  stale: false, guardianOff: false, red: 1, repos: [repo] };
const derive = (value: MainHealthData) => deriveMainHealthNeedsYou({ kind: 'available', data: value });

describe('main health needs you', () => {
  it('shows a red branch without a fix job', () => {
    expect(derive(data)).toMatchObject([{ id: 'main-red-phantom', severity: 'urgent',
      title: 'phantom master is red with no fix job: build', detail: expect.stringContaining('abcdef0'),
      nextStep: expect.stringContaining('guardian.log'), open: { kind: 'pane', paneId: 'fleet-lanes' } }]);
  });
  it.each([{ ...repo, fixJobs: ['job'] }, { ...repo, state: 'green' as const }, { ...repo, state: 'unknown' as const }])('does not show a healthy, unknown, or assigned repo', value => expect(derive({ ...data, repos: [value] })).toEqual([]));
  it('shows the kill switch alongside red repos and prefers it over stale', () => {
    expect(derive({ ...data, guardianOff: true, stale: true }).map(item => item.id)).toEqual(['main-red-phantom', 'main-guardian-off']);
  });
  it('shows stale status alongside red repos', () => {
    expect(derive({ ...data, stale: true }).map(item => item.id)).toEqual(['main-red-phantom', 'main-guardian-stale']);
    expect(derive({ ...data, repos: [], stale: true })[0]?.title).toContain('no status file');
    expect(derive({ ...data, repos: [], stale: true, statusAt: '2026-11-01T00:00:00Z' })[0]?.title).toContain('has not written since');
  });
  it('returns nothing without a read', () => expect(deriveMainHealthNeedsYou(undefined)).toEqual([]));
});
