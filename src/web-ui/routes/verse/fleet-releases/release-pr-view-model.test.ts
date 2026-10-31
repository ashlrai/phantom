import { describe, expect, it } from 'vitest';
import type { ReleasePr, ReleasePrResult } from '../fleet/release-pr-query.js';
import { releasePrRows } from './release-pr-view-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const pr = (overrides: Partial<ReleasePr> = {}): ReleasePr => ({
  number: 1479, title: 'chore(master): release 3.30.0', version: '3.30.0',
  url: 'https://github.com/ashlrai/phantom/pull/1479', openedAt: '2026-10-28T12:00:00Z',
  updatedAt: '2026-10-31T10:00:00Z', mergeable: 'UNKNOWN',
  checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', url: 'https://github.com/ashlrai/phantom/actions/runs/1' }],
  failing: ['Dependency audit (root + Raycast)'], pending: 0, blocked: true,
  summary: '3.30.0 blocked by Dependency audit (root + Raycast)', ...overrides,
});
const data = (pull: ReleasePr | null): ReleasePrResult => ({ kind: 'available', data: {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
  repos: [{ repo: 'AshlrAI/Phantom', path: '/fixture', pr: pull, notes: ['fixture note'] }],
} });

describe('releasePrRows', () => {
  it('shows a blocked PR, its checks, and notes under a normalized repo key', () => {
    expect(releasePrRows(data(pr()), now).get('ashlrai/phantom')).toEqual({
      headline: 'Release PR #1479 chore(master): release 3.30.0 · 3.30.0 blocked by Dependency audit (root + Raycast) · open since 3d ago',
      tone: 'danger', href: 'https://github.com/ashlrai/phantom/pull/1479', notes: ['fixture note'],
      checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', href: 'https://github.com/ashlrai/phantom/actions/runs/1' }],
    });
  });
  it('marks pending checks as a warning and green checks as ok', () => {
    expect(releasePrRows(data(pr({ blocked: false, pending: 1, summary: '3.30.0 waiting on 1 checks' })), now).get('ashlrai/phantom')?.tone).toBe('warn');
    expect(releasePrRows(data(pr({ blocked: false, pending: 0 })), now).get('ashlrai/phantom')?.tone).toBe('ok');
  });
  it('shows no PR and omits absent or unsupported data', () => {
    expect(releasePrRows(data(null), now).get('ashlrai/phantom')).toEqual({ headline: 'No release PR open', tone: 'neutral' });
    expect(releasePrRows({ kind: 'notInBuild' }, now).size).toBe(0);
    expect(releasePrRows(undefined, now).size).toBe(0);
  });
  it('drops unsafe URLs and keeps valid HTTP links', () => {
    const row = releasePrRows(data(pr({ url: 'javascript:alert(1)', checks: [
      { name: 'unsafe', state: 'fail', url: 'data:text/html,bad' },
      { name: 'valid', state: 'pending', url: 'http://example.test/run/1' },
    ] })), now).get('ashlrai/phantom');
    expect(row && 'href' in row && row.href).toBeNull();
    expect(row && 'checks' in row && row.checks.map(check => check.href)).toEqual([null, 'http://example.test/run/1']);
  });
});
