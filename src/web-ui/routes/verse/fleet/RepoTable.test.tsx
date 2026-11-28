/**
 * Fleet repo table: the fleet's own mirror clones are reported apart from
 * the repo rows (FleetLiveSnapshotV1.mirrors, 3.10 review follow-up).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SurfaceActions } from '../command/actions.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { mirrorsText, pausedReposText, RepoTable } from './RepoTable.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const actions = { act: () => undefined, busy: false, error: null, clearError: () => undefined, readOnly: true, dialogs: null } as SurfaceActions;

describe('mirrorsText', () => {
  it('says nothing for an older server, "unknown" for an unreadable registry, and never calls unknown "none"', () => {
    expect(mirrorsText(undefined)).toBeNull();
    expect(mirrorsText(null)).toMatch(/unknown/);
    expect(mirrorsText({ count: 0, repos: [] })).toMatch(/none yet/);
    expect(mirrorsText({ count: 1, repos: ['ashlrai/binshield'] })).toBe(
      "Fleet mirrors: 1 working copy (ashlrai/binshield) — the fleet's own clones of the repos above.",
    );
    const many = Array.from({ length: 8 }, (_, i) => `ashlrai/r${i}`);
    expect(mirrorsText({ count: 8, repos: many })).toContain('and 2 more');
  });
});

describe('pausedReposText', () => {
  it('says nothing for an older server or a tick that paused nothing, "unknown" without a fresh tick, and names each pause', () => {
    expect(pausedReposText(undefined)).toBeNull();
    expect(pausedReposText([])).toBeNull();
    expect(pausedReposText(null)).toMatch(/unknown/);
    expect(pausedReposText([{ repo: 'ashlrai/binshield', reason: 'Its mirror is not current (fetch failed).', kind: 'mirror' }])).toBe(
      'Paused this tick: ashlrai/binshield — Its mirror is not current (fetch failed).',
    );
    const many = Array.from({ length: 6 }, (_, i) => ({ repo: `ashlrai/r${i}`, reason: 'On quarantine: x' }));
    expect(pausedReposText(many)).toContain('and 2 more');
  });
});

describe('RepoTable', () => {
  it.each([false, true])('labels an uncapped repository without a numeric sentinel (compact %s)', (compact) => {
    const live = fleetLive('live', NOW);
    live.repos = [{ ...live.repos[0]!, mergesToday: 3, maxMergesPerDay: Number.MAX_SAFE_INTEGER }];
    render(<RepoTable read={{ value: live, available: true, reason: null }} actions={actions} now={NOW} compact={compact} />);
    expect(screen.getByText('3 / No volume cap')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(String(Number.MAX_SAFE_INTEGER)))).not.toBeInTheDocument();
  });

  it('lists mirrors under the table, not as repo rows', () => {
    const live = { ...fleetLive('live', NOW), mirrors: { count: 2, repos: ['ashlrai/ashlr-hub', 'ashlrai/binshield'] } };
    render(<RepoTable read={{ value: live, available: true, reason: null }} actions={actions} now={NOW} compact={false} />);
    expect(screen.getByText(/Fleet mirrors: 2 working copies \(ashlrai\/ashlr-hub, ashlrai\/binshield\)/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(live.repos.length + 1);
  });

  it('lists the tick-paused repos under the table with their reasons', () => {
    const live = { ...fleetLive('live', NOW), pausedRepos: [{ repo: 'ashlrai/binshield', reason: 'Its mirror is not current (fetch failed).', kind: 'mirror' as const }] };
    render(<RepoTable read={{ value: live, available: true, reason: null }} actions={actions} now={NOW} compact={false} />);
    expect(screen.getByText(/Paused this tick: ashlrai\/binshield — Its mirror is not current/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(live.repos.length + 1);
  });
});
