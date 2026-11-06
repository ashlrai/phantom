import { describe, expect, it } from 'vitest';
import type { ReleasePr, ReleasePrResult } from '../../routes/verse/fleet/release-pr-query.js';
import { deriveReleaseNeedsYou } from '../../routes/verse/shell/release-needs-you.js';
import { deriveReleasePrNotifications } from './deriveReleasePrNotifications.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const pr: ReleasePr = {
  number: 42, title: 'Release 3.30.0', version: '3.30.0', url: 'https://example.test/pr/42',
  openedAt: '2026-10-31T10:00:00Z', updatedAt: '2026-10-31T11:00:00Z', mergeable: 'MERGEABLE',
  checks: [{ name: 'Merge Gate', state: 'fail', url: null }], failing: ['Merge Gate'],
  pending: 0, blocked: true, summary: 'Blocked',
};
function result(overrides: Partial<ReleasePr> = {}): ReleasePrResult {
  return { kind: 'available', data: { v: 1, generatedAt: pr.updatedAt, sourceState: 'healthy',
    repos: [{ repo: 'ashlrai/phantom', path: '/repo', pr: { ...pr, ...overrides }, notes: [] }] } };
}

describe('deriveReleasePrNotifications', () => {
  it('raises a high severity notification for a failing release PR with a stable id', () => {
    const input = result();
    const [item] = deriveReleasePrNotifications(input, now);
    expect(item).toEqual(expect.objectContaining({ id: 'fleet-release-blocked:ashlrai/phantom:42',
      category: 'fleet', severity: 'high', title: 'Release PR #42 is blocked',
      detail: 'Merge Gate failing · open 2 h', ts: pr.openedAt, actionLabel: 'Open releases',
      actionHref: expect.stringContaining('fleet-releases') }));
    expect(deriveReleasePrNotifications(input, now + 60_000)[0]?.id).toBe(item?.id);
    expect(item?.detail).toBe(deriveReleaseNeedsYou(input, now)[0]?.detail);
  });

  it('uses medium severity and the drawer wording for pending or conflicting checks', () => {
    const pending = result({ checks: [{ name: 'Build', state: 'pending', url: null }], failing: [], pending: 1 });
    expect(deriveReleasePrNotifications(pending, now)[0]).toEqual(expect.objectContaining({
      severity: 'medium', detail: '1 check pending · open 2 h',
    }));
    const conflict = result({ checks: [], failing: [], mergeable: 'CONFLICTING' });
    expect(deriveReleasePrNotifications(conflict, now)[0]?.detail).toBe(deriveReleaseNeedsYou(conflict, now)[0]?.detail);
  });

  it('uses failed check names as a fallback, limits names, and scrubs long tokens', () => {
    const token = 'x'.repeat(32);
    const input = result({ failing: [], checks: ['one', token, 'three', 'four'].map((name) => ({ name, state: 'fail', url: null })) });
    expect(deriveReleasePrNotifications(input, now)[0]).toEqual(expect.objectContaining({
      severity: 'high', detail: 'one, …, three failing · open 2 h',
    }));
    expect(deriveReleasePrNotifications(result({ failing: [token] }), now)[0]?.detail).toBe('… failing · open 2 h');
  });

  it('ignores resolved, unavailable, and malformed input', () => {
    expect(deriveReleasePrNotifications(result({ blocked: false }), now)).toEqual([]);
    expect(deriveReleasePrNotifications({ kind: 'notInBuild' }, now)).toEqual([]);
    expect(deriveReleasePrNotifications({ kind: 'available', data: { repos: [{}] } }, now)).toEqual([]);
    expect(deriveReleasePrNotifications('garbage', now)).toEqual([]);
  });
});
