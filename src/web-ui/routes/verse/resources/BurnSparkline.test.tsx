import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { BurnSparkline } from './BurnSparkline.js';
import { sameWorldLaneRow, worldLaneRows, type WorldLaneRow } from './world-lane-rows.js';

afterEach(cleanup);
const history: NonNullable<WorldLaneRow['history']> = {
  points: [0, 1, 2, 3].map((t) => ({ t, fraction: t / 4, gapBefore: t === 2 })),
  burnPerHour: 4, exhaustAt: '2026-11-16T13:00:00Z', resetAt: '2026-11-16T14:00:00Z',
};
const now = Date.parse('2026-11-16T12:00:00Z');
it('hides missing or single-point history', () => {
  const { container, rerender } = render(<BurnSparkline history={null} />);
  expect(container.querySelector('svg')).toBeNull();
  rerender(<BurnSparkline history={{ ...history, points: history.points.slice(0, 1) }} />);
  expect(container.querySelector('svg')).toBeNull();
});
it('splits segments at raw gaps and marks only measured future-reset forecasts', () => {
  const { container, rerender } = render(<BurnSparkline history={history} now={now} />);
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Burn history, 4 measured points');
  expect(container.querySelectorAll('polyline')).toHaveLength(2);
  expect(container.querySelector('[data-exhaust="before-reset"]')).not.toBeNull();
  rerender(<BurnSparkline history={{ ...history, exhaustAt: '2026-11-16T15:00:00Z' }} now={now} />);
  expect(container.querySelector('[data-exhaust="after-reset"]')).not.toBeNull();
  for (const patch of [{ burnPerHour: null }, { resetAt: null }, { exhaustAt: null }, { resetAt: '2026-11-15T14:00:00Z' }]) {
    rerender(<BurnSparkline history={{ ...history, ...patch }} now={now} />);
    expect(container.querySelector('[data-exhaust]')).toBeNull();
  }
});
it('parses history tolerantly and invalidates row equality on history changes', () => {
  const row = (raw: unknown) => worldLaneRows({ sensors: { lanes: [{ lane: 'devin', history: raw }] } }, now).find(r => r.lane === 'devin')!;
  const raw = { points: [null, { observedAt: 'bad', used: 2, limit: 4 },
    { observedAt: '2026-11-16T12:00:00Z', used: 2, limit: 4, gapBefore: true },
    { observedAt: '2026-11-16T12:00:00Z', used: 2, limit: 0 }], burn: { perHour: 2 } };
  expect(row(raw).history?.points).toEqual([{ t: now, fraction: 0.5, gapBefore: true }]);
  expect(sameWorldLaneRow(row(raw), row(raw))).toBe(true);
  expect(sameWorldLaneRow(row(raw), row(null))).toBe(false);
  expect(row({ points: [null], burn: { perHour: Infinity } }).history).toBeNull();
});
