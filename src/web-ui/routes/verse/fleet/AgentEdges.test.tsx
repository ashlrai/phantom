import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { projectFleetEdges } from '../../../../core/fleet/fleet-edges.js';
import { AgentEdges } from './AgentEdges.js';
import { useQuery } from '../../../data/hooks.js';
vi.mock('../../../data/hooks.js', () => ({ useQuery: vi.fn() }));
it('renders message lines from the shared fixture projection with provider marks and unknowns', () => {
  const envelope = { id: '1', from: 'codex-a', to: 'claude-b', priority: 'P2' as const, ttl: 1000, body: {}, sender: { agent_id: 'codex-a', vendor: 'openai', human: false, team: true } };
  const edges = projectFleetEdges([{ cursor: 1, receivedAt: 10, envelope }]);
  vi.mocked(useQuery).mockReturnValue({ data: { schema: 'fleet.edges.v1', source: 'available', edges }, error: null } as never);
  render(<AgentEdges />);
  const row = screen.getByRole('listitem');
  expect(within(row).getByText('codex-a')).toBeInTheDocument();
  expect(within(row).getByText('claude-b')).toBeInTheDocument();
  expect(within(row).getByText('Provider unknown')).toBeInTheDocument();
  expect(row.querySelector('svg')).toBeInTheDocument();
  expect(within(row).getByLabelText('messaged')).toBeInTheDocument();
});
