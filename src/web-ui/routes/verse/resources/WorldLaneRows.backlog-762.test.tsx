import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldLaneRows } from './WorldLaneRows.js';
import { resetCountdown } from './world-lane-rows.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const field = (value: unknown) => ({ value, source: 'claude-usage', observedAt: new Date(NOW).toISOString(), freshness: 'fresh' });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('preserved resource sidebar from #6585', () => {
  it.each([
    [1, 'resets in 1m'], [60_000, 'resets in 1m'],
    [3_600_000, 'resets in 1h'], [3_660_000, 'resets in 1h 1m'],
    [48 * 3_600_000, 'resets in 2d'], [49 * 3_600_000, 'resets in 2d 1h'],
    [0, 'reset due'], [-1, 'reset due'],
  ])('formats a reset %i ms away as %s', (offset, expected) => {
    expect(resetCountdown(new Date(NOW + offset).toISOString(), NOW)).toBe(expected);
  });

  it('does not invent countdowns for absent or invalid reset evidence', () => {
    expect(resetCountdown(null, NOW)).toBeNull();
    expect(resetCountdown('invalid', NOW)).toBeNull();
  });

  it('updates a cached reset countdown and keeps diagnostic details accessible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = { sensors: { lanes: [{ lane: 'claude-max', used: field(40), remaining: field(60),
      unit: field('percent'), burnRate: field(1), resetAt: field(new Date(NOW + 180_000).toISOString()),
    }] } };
    const { unmount } = render(<WorldLaneRows expanded snapshot={snapshot} />);
    const provider = screen.getByRole('group', { name: 'Claude resources' });
    const row = within(provider).getByRole('button', { name: /Claude subscription/ });
    expect(within(provider).getAllByRole('button')).toHaveLength(2);
    expect(row).toHaveTextContent('resets in 3m');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(row).toHaveTextContent('resets in 2m');

    fireEvent.focus(row);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Burn 1%/h');
    expect(tooltip).toHaveTextContent('Reset Nov 9, 12:03 PM UTC');
    expect(tooltip).toHaveTextContent('Source claude-usage');
    expect(tooltip).toHaveTextContent('Observed fresh · 1m ago');

    fireEvent.blur(row);
    act(() => { vi.advanceTimersByTime(14 * 60_000); });
    expect(row).toHaveAttribute('data-freshness', 'stale');
    expect(row).toHaveTextContent('stale · 15m ago');
    expect(row).not.toHaveTextContent('resets in');
    expect(row.querySelector('[data-gauge]')).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
