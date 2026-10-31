import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Swimlane, type SwimlaneLane } from './Swimlane.js';

const from = Date.parse('2026-10-31T10:00:00Z');
const item = { id: 'job-1', label: 'Job one', start: from, end: from + 60_000, status: 'running' };
const lane: SwimlaneLane = { id: 'lane-1', label: 'Codex', items: [item] };
const props = { title: 'Runs', width: 600, from, to: from + 3_600_000, lanes: [lane] };

it('selects an item and its lane with click and Enter', async () => {
  const select = vi.fn();
  const user = userEvent.setup();
  render(<Swimlane {...props} onSelectItem={select} />);
  const bar = screen.getByRole('button', { name: 'Codex: Job one' });
  expect(bar).toHaveAttribute('type', 'button');
  fireEvent.click(bar);
  bar.focus();
  await user.keyboard('{Enter}');
  expect(select).toHaveBeenCalledTimes(2);
  expect(select).toHaveBeenNthCalledWith(1, item, lane);
  expect(select).toHaveBeenNthCalledWith(2, item, lane);
});

it('does not render bar buttons when selection is absent', () => {
  const { container } = render(<Swimlane {...props} />);
  expect(container.querySelector('foreignObject button')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Codex: Job one' })).not.toBeInTheDocument();
});
