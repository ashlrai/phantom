import { describe, expect, it } from 'vitest';
import type { ReleasePr, ReleasePrData, ReleasePrResult } from '../fleet/release-pr-query.js';
import { releaseStrip } from './release-strip-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const pr = (overrides: Partial<ReleasePr> = {}): ReleasePr => ({
  number: 1479, title: 'release 3.30.0', version: '3.30.0', url: 'https://github.com/ashlrai/phantom/pull/1479',
  openedAt: '2026-10-30T12:00:00Z', updatedAt: '2026-10-31T10:00:00Z', mergeable: 'CONFLICTING',
  checks: [{ name: 'Dependency audit', state: 'fail', url: 'https://github.com/ashlrai/phantom/actions/runs/1' }],
  failing: ['Dependency audit'], pending: 0, blocked: true, summary: '3.30.0 blocked by Dependency audit', ...overrides,
});
const data = (pull: ReleasePr | null = pr()): ReleasePrResult => ({ kind: 'available', data: {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [{ repo: 'ashlrai/phantom', path: '/phantom', pr: pull, notes: [] }],
} });
const snapshot = (value: ReleasePrData): ReleasePrResult => ({ kind: 'available', data: value });

describe('releaseStrip', () => {
  it('shows the blocker and checks', () => {
    expect(releaseStrip(data(), now)).toEqual({ text: '3.30.0 blocked by Dependency audit · open since 1d ago', tone: 'danger',
      href: 'https://github.com/ashlrai/phantom/pull/1479', failing: ['Dependency audit'],
      checks: [{ name: 'Dependency audit', state: 'fail', url: 'https://github.com/ashlrai/phantom/actions/runs/1' }] });
  });
  it('uses warning for pending and ok for green', () => {
    expect(releaseStrip(data(pr({ blocked: false, pending: 2, summary: '3.30.0 waiting on 2 checks' })), now)?.tone).toBe('warning');
    expect(releaseStrip(data(pr({ blocked: false, pending: 0, summary: '3.30.0 green, waiting for merge' })), now)?.tone).toBe('ok');
  });
  it('reports no release PR and hides an unavailable route', () => {
    expect(releaseStrip(data(null), now)).toEqual({ text: 'No release PR open', tone: 'neutral', href: null, failing: [], checks: [] });
    expect(releaseStrip({ kind: 'notInBuild' }, now)).toBeNull();
  });
  it('marks degraded readings, including an empty result', () => {
    const value = data(); if (value.kind !== 'available') throw new Error('fixture');
    value.data.sourceState = 'degraded';
    expect(releaseStrip(value, now)?.text).toContain(' · GitHub unreachable, showing the last answer');
    value.data.repos[0].pr = null;
    expect(releaseStrip(value, now)?.text).toBe('No release PR open · GitHub unreachable, showing the last answer');
  });
  it('prefers phantom with a PR, falls back, and respects a repo filter', () => {
    const value = data(); if (value.kind !== 'available') throw new Error('fixture');
    value.data.repos.unshift({ repo: 'ashlrai/other', path: '/other', pr: pr({ summary: 'other release' }), notes: [] });
    expect(releaseStrip(value, now)?.text).toContain('3.30.0 blocked');
    expect(releaseStrip(value, now, 'ashlrai/other')?.text).toContain('other release');
    value.data.repos[1].pr = null;
    expect(releaseStrip(snapshot(value.data), now)?.text).toContain('other release');
    expect(releaseStrip(value, now, 'ashlrai/phantom')?.text).toBe('No release PR open');
  });
  it('drops non-GitHub and deceptive check and PR links', () => {
    const view = releaseStrip(data(pr({ url: 'https://github.com.evil.test/pull/1', checks: [
      { name: 'bad', state: 'fail', url: 'https://evil.test/' }, { name: 'credentials', state: 'pending', url: 'https://github.com@evil.test/' },
    ] })), now);
    expect(view?.href).toBeNull();
    expect(view?.checks.map(check => check.url)).toEqual([null, null]);
  });
});
