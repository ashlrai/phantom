import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fleetLive } from '../command/fixtures.test-support.js';
import { workspaceGraph } from './workspace-graph.js';
import { WorkspaceGraph } from './WorkspaceGraph.js';
import FleetWorld from './FleetWorld.js';

describe('graph.v1 control room smoke', () => {
  it('renders fixture nodes, membership edges and an inbox, then follows live state by identity', () => {
    const live = fleetLive('live', Date.parse('2026-10-06T20:00:00Z'));
    const run = { ...live.runs[0]!, hold: { kind: 'park' as const, reason: 'Waiting for a seat', nextEligibleAt: null } };
    const graph = workspaceGraph({ ...live, runs: [run] });
    expect(graph.schema).toBe('graph.v1');
    expect(graph.edges).toEqual([{ id: `run:${run.id}`, from: `repository:${run.repo}`, to: `run:${run.id}`, kind: 'contains' }]);
    const { rerender } = render(<WorkspaceGraph graph={graph} />);
    expect(screen.getByRole('img', { name: `contains: repository:${run.repo} → run:${run.id}` })).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a seat/)).toBeInTheDocument();
    const nodeButton = screen.getByRole('button', { name: `Inspect workspace node run:${run.id}` });
    nodeButton.focus();
    expect(nodeButton).toHaveFocus();
    fireEvent.click(nodeButton);
    expect(nodeButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: `Inspect inbox node run:${run.id}` }));
    const inspector = screen.getByRole('complementary', { name: 'Selected workspace node' });
    expect(inspector).toHaveTextContent(run.title);
    rerender(<WorkspaceGraph graph={workspaceGraph({ ...live, runs: [{ ...run, hold: null, outcome: 'proposed' }] })} />);
    expect(inspector).toHaveTextContent('proposed');
    expect(screen.getByText('No recorded holds in this snapshot.')).toBeInTheDocument();
    rerender(<WorkspaceGraph graph={workspaceGraph({ ...live, runs: [] })} />);
    expect(inspector).toHaveTextContent('no longer in the current snapshot');
    expect(within(inspector).queryByText(run.title)).not.toBeInTheDocument();
  });

  it('gates the control room behind agentWorkspace in the live Fleet world', () => {
    const read = { value: fleetLive('live', Date.parse('2026-10-06T20:00:00Z')), available: true, reason: null };
    const { rerender } = render(<FleetWorld read={read} />);
    expect(screen.queryByRole('region', { name: 'Agent workspace control room' })).not.toBeInTheDocument();
    rerender(<FleetWorld read={read} agentWorkspace />);
    expect(screen.getByRole('region', { name: 'Agent workspace control room' })).toBeInTheDocument();
  });

  it('bounds a large fixture and reports omissions', () => {
    const graph = { schema: 'graph.v1' as const, observedAt: '2026-10-06T20:00:00Z', state: 'idle' as const,
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, kind: 'run' as const, label: `Run ${i}`, state: 'pending' })), edges: [], inbox: [] };
    render(<WorkspaceGraph graph={graph} />);
    expect(screen.getAllByRole('button')).toHaveLength(80);
    expect(screen.getByRole('status')).toHaveTextContent('80 of 100 nodes');
  });
});
