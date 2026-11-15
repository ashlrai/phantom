import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { projectFleetEdges } from '../../../../core/fleet/fleet-edges.js';
import { AgentEdges } from './AgentEdges.js';
import { useQuery } from '../../../data/hooks.js';
vi.mock('../../../data/hooks.js', () => ({ useQuery: vi.fn() }));
it('renders message lines from the shared fixture projection with provider marks and unknowns', () => {
  const envelope = { id: '1', from: 'codex-a', to: 'claude-b', priority: 'P2' as const, ttl: 1000, body: {}, sender: { agent_id: 'codex-a', vendor: 'openai', human: false, team: true } };
  const edges = projectFleetEdges([{ cursor: 1, receivedAt: 10, envelope },
    { cursor: 2, receivedAt: 10, envelope: { ...envelope, id: '2', from: 'claude-b', to: 'agent-c', sender: { ...envelope.sender, agent_id: 'claude-b', vendor: 'anthropic' } } }], 10);
  vi.mocked(useQuery).mockReturnValue({ data: { schema: 'fleet.edges.v1', source: 'available', edges }, error: null } as never);
  render(<AgentEdges />);
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(screen.getByText('agent-c')).toBeInTheDocument();
  const row = screen.getByText('codex-a').closest('li')!;
  expect(within(row).getByText('codex-a')).toBeInTheDocument();
  expect(within(row).getByText('claude-b')).toBeInTheDocument();
  expect(within(row).getByText('anthropic')).toBeInTheDocument();
  expect(row.querySelector('svg')).toBeInTheDocument();
  expect(within(row).getByLabelText('messaged')).toBeInTheDocument();
});
it('shows an empty bus', () => {
  vi.mocked(useQuery).mockReturnValue({ data: { schema: 'fleet.edges.v1', source: 'available', edges: [] }, error: null } as never);
  render(<AgentEdges />);
  expect(screen.getByText('No live agent messages.')).toBeInTheDocument();
});
