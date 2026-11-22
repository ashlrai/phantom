import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorktreesReport } from '../../../../core/fleet/worktrees.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { bytesText, DiskCard } from './DiskCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => vi.fn() }));

const REPORT: WorktreesReport = {
  schema: 'worktrees.v1', generatedAt: '2026-11-17T12:00:00.000Z', sourcesOk: true, warnAt: 40,
  counts: { total: 540, safe: 412, live: 9, merged: 300, empty: 130, open: 80, kept: 6, unknown: 15 },
  reaper: { state: 'stale', reason: 'never-ran', lastRunAt: null, lastRunAgeHours: null, lastRun: null, eligible: [], stuckRuns: [], next: null },
  reclaimableBytes: 612_400_000_000, reclaimableComplete: true, mode: 'list', rows: [],
};
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, status = 'success') => {
  viewport = mockViewport(width); state.read = { status, data };
  return render(<DiskCard />);
};
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Disk card at %s', (_name, width) => {
  it('shows the count against the warning level, counts by state and the reclaimable size', () => {
    show(REPORT, width);
    const card = within(screen.getByRole('region', { name: 'Disk' }));
    expect(card.getByText('540 job worktrees, over the warning level of 40.').hasAttribute('data-warn')).toBe(true);
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'merged PR: 300', 'empty result: 130', 'open PR: 80', 'live job: 9', 'kept on purpose: 6', 'unknown: 15',
    ]);
    expect(card.getByText('Safe to remove: 412 (612.4 GB).')).toBeTruthy();
    expect(card.getByText('phm worktrees --reap --plan').tagName).toBe('CODE');
    expect(card.getByText('phm worktrees --reap --apply').tagName).toBe('CODE');
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });

  it('empty state: says there are no job worktrees', () => {
    show({ ...REPORT, counts: { total: 0, safe: 0, live: 0, merged: 0, empty: 0, open: 0, kept: 0, unknown: 0 }, reclaimableBytes: 0 }, width);
    const card = within(screen.getByRole('region', { name: 'Disk' }));
    expect(card.getByText('No job worktrees.')).toBeTruthy();
    expect(card.queryByText(/Safe to remove/)).toBeNull();
  });
});

it('under the warning level, with nothing safe and an unreadable source, says so without the command', () => {
  show({ ...REPORT, sourcesOk: false, counts: { total: 12, safe: 0, live: 2, merged: 0, empty: 0, open: 4, kept: 0, unknown: 6 }, reclaimableBytes: 0 });
  const card = within(screen.getByRole('region', { name: 'Disk' }));
  expect(card.getByText('12 job worktrees.').hasAttribute('data-warn')).toBe(false);
  expect(card.getAllByRole('listitem')).toHaveLength(3);
  expect(card.getByText('Safe to remove: 0 (0 KB).')).toBeTruthy();
  expect(card.getByText('Some records could not be read, so nothing is marked safe.')).toBeTruthy();
  expect(card.queryByText(/phm worktrees/)).toBeNull();
});

it('marks a partial size as a floor', () => {
  show({ ...REPORT, reclaimableComplete: false });
  expect(screen.getByText('Safe to remove: 412 (612.4 GB or more).')).toBeTruthy();
});

it('says unknown when the read fails, and stays hidden before the read or for another payload', () => {
  show(undefined, 390, 'error');
  expect(screen.getByText('Unknown: the worktree list could not be read.')).toBeTruthy();
  cleanup();
  for (const data of [undefined, { error: 'nope' }, { schema: 'home.v1' }]) {
    expect(show(data).container.innerHTML).toBe('');
    cleanup();
  }
});

it('formats sizes in plain units', () => {
  expect([0, 400, 2_500_000, 1_234_000_000].map(bytesText)).toEqual(['0 KB', '1 KB', '3 MB', '1.2 GB']);
});
