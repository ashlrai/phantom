import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ResetsTimeline } from './ResetsTimeline.js';

it('renders reset readings in order, including unknowns and the use-it tag', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  render(<ResetsTimeline nowMs={now} readings={[
    { label: 'Later', windows: [{ resetsAt: '2026-11-11T12:00:00.000Z', usedPercent: null }] },
    { label: 'Soon', windows: [{ resetsAt: '2026-11-10T14:00:00.000Z', usedPercent: 60 }] },
    { label: 'Missing', windows: [] },
  ]} />);
  const items = within(screen.getByRole('region', { name: 'Resets' })).getAllByRole('listitem');
  expect(items[0].textContent).toContain('Soon · resets');
  expect(items[0].textContent).toContain('(in 2h) · 40% left · use it');
  expect(items[1].textContent).toContain('left: unknown');
  expect(screen.getByText('No reset reading: Missing')).toBeTruthy();
});
