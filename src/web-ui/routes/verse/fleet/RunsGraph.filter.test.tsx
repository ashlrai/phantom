import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { RunsGraph } from './RunsGraph.js';
import styles from './runs-graph.module.css';

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, workers: [
    { job: 'RQ-PHX-A', lane: 'personal', tier: 'frontier' },
    { job: 'RQ-PHX-B', lane: 'shared', tier: 'mid' },
  ], leaders: [], mergesLastHour: { count: 0 }, switches: [] })));
});
afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('filters nodes and edges, selects the first match, and clears on Escape', async () => {
  const { container } = render(<RunsGraph />);
  const personal = await screen.findByRole('button', { name: 'Inspect workspace node run:RQ-PHX-A' });
  const shared = screen.getByRole('button', { name: 'Inspect workspace node run:RQ-PHX-B' });
  const input = screen.getByRole('searchbox', { name: 'Filter graph nodes' });
  fireEvent.change(input, { target: { value: 'PERSONAL' } });
  expect(personal).not.toHaveClass(styles.dimmed);
  expect(shared).toHaveClass(styles.dimmed);
  expect(shared).not.toHaveAttribute('aria-hidden');
  expect(screen.getByText('2 of 4 nodes')).toBeInTheDocument();
  const edges = [...container.querySelectorAll('path[role="img"]')];
  expect(edges.filter(edge => edge.classList.contains(styles.dimmed))).toHaveLength(1);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(within(screen.getByRole('group', { name: 'Selected node' })).getByRole('button', { name: 'Open Lanes pane' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Inspect workspace node lane:personal' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(input, { target: { value: 'RQ-PHX-A' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(within(screen.getByRole('group', { name: 'Selected node' })).getByRole('button', { name: 'Open worker log' })).toBeInTheDocument();
  expect(personal).toHaveAttribute('aria-pressed', 'true');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input).toHaveValue('');
  expect(shared).not.toHaveClass(styles.dimmed);
  expect(edges.every(edge => !edge.classList.contains(styles.dimmed))).toBe(true);
  expect(screen.queryByText('1 of 4 nodes')).not.toBeInTheDocument();
});
