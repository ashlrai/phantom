import { expect, it } from 'vitest';
import type { ReleasePrData, ReleasePrResult } from '../fleet/release-pr-query.js';
import { deriveReleaseNeedsYou } from './release-needs-you.js';
import { releaseVersionGuard } from '../fleet-releases/release-version-guard.js';

const now = Date.parse('2026-11-01T06:00:00Z');
const pr = { number: 1479, title: 'chore(master): release 3.29.16', version: '3.29.16',
  updatedAt: '2026-10-31T13:00:00Z', openedAt: '2026-10-28T12:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/1479',
  mergeable: 'MERGEABLE', checks: [], failing: [], pending: 0, blocked: false, summary: 'green' };
const result = (fields: Partial<ReleasePrData['repos'][number]>): ReleasePrResult => ({ kind: 'available', data: {
  v: 1, generatedAt: '2026-11-01T06:00:00Z', sourceState: 'healthy',
  repos: [{ repo: 'ashlrai/phantom', path: '/fixture', notes: [], pr, ...fields }],
} });
it.each([{}, { versionVerdict: 'downgrade' as const }])('makes a green downgrade urgent with fields %j', fields => {
  expect(deriveReleaseNeedsYou(result({ treeVersion: '3.30.0', ...fields }), now)).toEqual([{
    id: 'release-downgrade:ashlrai/phantom:1479', severity: 'urgent',
    title: 'Release PR #1479 would ship 3.29.16, not 3.30.0',
    detail: releaseVersionGuard(pr, '3.30.0', now).line,
    nextStep: "fix release-please's version before merging; the desktop merge button is blocked",
    target: 'fleet', open: { kind: 'pane', paneId: 'fleet-releases' },
  }]);
});
it('keeps the green row without tree data', () => {
  expect(deriveReleaseNeedsYou(result({}), now)[0]).toMatchObject({ severity: 'attention', title: 'Release PR #1479 is green' });
});
it('honors an explicit server verdict', () => {
  expect(deriveReleaseNeedsYou(result({ treeVersion: '3.30.0', versionVerdict: 'ahead' }), now)[0]?.title).toBe('Release PR #1479 is green');
});
