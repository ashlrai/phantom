import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceGraph } from './WorkspaceGraph.js';
import type { WorkspaceGraphV1 } from './workspace-graph.js';

const graph: WorkspaceGraphV1 = {
  schema: 'graph.v1', observedAt: '2026-10-31T12:00:00Z', state: 'running',
  nodes: [{ id: 'run:one', kind: 'run', label: 'One', state: 'running' }], edges: [],
  inbox: [{ id: 'hold', nodeId: 'run:one', message: 'Held', nextEligibleAt: null }],
};

it('reports selection and deselection from nodes and inbox', () => {
  const onSelect = vi.fn();
  render(<WorkspaceGraph graph={graph} onSelect={onSelect} />);
  const node = screen.getByRole('button', { name: 'Inspect workspace node run:one' });
  fireEvent.click(node);
  expect(onSelect).toHaveBeenLastCalledWith('run:one');
  fireEvent.click(node);
  expect(onSelect).toHaveBeenLastCalledWith(null);
  expect(node).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Inspect inbox node run:one' }));
  expect(onSelect).toHaveBeenLastCalledWith('run:one');
});

it('retains selection on repeated clicks without the optional callback', () => {
  render(<WorkspaceGraph graph={graph} />);
  const node = screen.getByRole('button', { name: 'Inspect workspace node run:one' });
  fireEvent.click(node);
  fireEvent.click(node);
  expect(node).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('complementary', { name: 'Selected workspace node' })).toHaveTextContent('One');
});
