import { describe, expect, it } from 'vitest';
import type { ReleasePr, ReleasePrResult } from '../fleet/release-pr-query.js';
import { deriveReleaseNeedsYou } from './release-needs-you.js';

const now = Date.parse('2026-10-31T12:00:00Z');

const greenPr: ReleasePr = {
  number: 1479, title: 'Release 3.30.0', version: '3.30.0',
  url: 'https://example.com/pr/1479', openedAt: '2026-10-31T04:00:00Z',
  updatedAt: '2026-10-31T12:00:00Z', mergeable: 'MERGEABLE',
  checks: [{ name: 'Merge Gate', state: 'pass', url: null }],
  failing: [], pending: 0, blocked: false, summary: 'green',
};
const blockedPr: ReleasePr = {
  number: 1478, title: 'Release 3.29.0', version: '3.29.0',
  url: 'https://example.com/pr/1478', openedAt: '2026-10-31T08:00:00Z',
  updatedAt: '2026-10-31T12:00:00Z', mergeable: 'MERGEABLE',
  checks: [{ name: 'lint', state: 'fail', url: null }],
  failing: ['lint'], pending: 0, blocked: true, summary: 'blocked',
};

const result = (pr: ReleasePr | null): ReleasePrResult => ({
  kind: 'available', data: {
    v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
    repos: [{ repo: 'example/repo', path: '/fake', pr, notes: [] }],
  }
});

describe('deriveReleaseNeedsYou — green PR (ready items)', () => {
  it('returns one ready item with the expected id, title and url for a green PR', () => {
    const items = deriveReleaseNeedsYou(result(greenPr), now);
    expect(items).toEqual([{
      id: 'release-ready:example/repo',
      severity: 'attention',
      title: 'Release PR #1479 is green',
      detail: '3.30.0 · open 8 h · waiting for your merge',
      nextStep: 'Open the release PR; Merge Gate reports all green',
      target: 'fleet',
      open: { kind: 'pane', paneId: 'fleet-releases' },
    }]);
  });

  it('returns a ready item for a PR with title but no version', () => {
    const titleOnly = { ...greenPr, version: null, title: 'Bump dependencies' };
    const items = deriveReleaseNeedsYou(result(titleOnly), now);
    expect(items[0]?.id).toBe('release-ready:example/repo');
    expect(items[0]?.title).toBe('Release PR #1479 is green');
    expect(items[0]?.detail).toBe('Bump dependencies · open 8 h · waiting for your merge');
  });
});

describe('deriveReleaseNeedsYou — cases that yield no ready item', () => {
  it('blocked PR produces no ready item (blocked item still appears elsewhere)', () => {
    const items = deriveReleaseNeedsYou(result(blockedPr), now);
    const readyItems = items.filter(item => item.id.startsWith('release-ready:'));
    expect(readyItems).toEqual([]);
    expect(items.some(item => item.id.startsWith('release-blocked:'))).toBe(true);
  });

  it('pending checks produce no ready item', () => {
    const pending = { ...greenPr, checks: [{ name: 'build', state: 'pending' as const, url: null }], failing: [], pending: 1 };
    expect(deriveReleaseNeedsYou(result(pending), now)).toEqual([]);
  });

  it('a failing check produces no ready item', () => {
    const failing = { ...greenPr, checks: [{ name: 'test', state: 'fail' as const, url: null }], failing: ['test'], pending: 0 };
    expect(deriveReleaseNeedsYou(result(failing), now)).toEqual([]);
  });

  it('notInBuild returns empty', () => {
    expect(deriveReleaseNeedsYou({ kind: 'notInBuild' }, now)).toEqual([]);
  });

  it('undefined result returns empty', () => {
    expect(deriveReleaseNeedsYou(undefined, now)).toEqual([]);
  });
});
