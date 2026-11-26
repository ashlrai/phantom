import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RelativeTime } from './RelativeTime.js';
import { ageInSeconds } from '../../lib/relative-time.js';

it.each([[59, '59s ago'], [60, '1m ago'], [3660, '1h 1m ago'], [86400, '1d ago'], [553560, '6d 9h ago']])('formats %s seconds as %s', (seconds, text) => {
  expect(ageInSeconds(seconds)).toBe(text);
});

it('exposes the actual observation instant and never presents absent or future time as an observation', () => {
  const value = '2026-11-20T15:00:00.000Z', now = Date.parse(value) + 553_560_000;
  const { rerender } = render(<RelativeTime value={value} now={now} />);
  expect(screen.getByText('6d 9h ago')).toHaveAttribute('title', value);
  expect(screen.getByText('6d 9h ago')).toHaveAttribute('datetime', value);
  rerender(<RelativeTime value={value} now={0} />);
  expect(screen.getByText('time unknown')).not.toHaveAttribute('title');
  rerender(<RelativeTime value={null} now={now} />);
  expect(screen.getByText('time unknown')).not.toHaveAttribute('datetime');
});
