import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { FleetReplicaSource } from '../../../../core/fleet/fleet-replica.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree, type OrgTreeLane } from '../../../../core/fleet/org-tree.js';
import { FleetMachineScope } from './FleetMachineScope.js';

const now = Date.parse('2026-11-24T12:01:00Z');
const pro: FleetReplicaSource = {
  machine: 'Pro', via: 'leader-replica', asOf: '2026-11-24T12:00:58Z', ageSeconds: 0, stale: false, reason: null,
};
const muse = { ...pro, machine: 'Muse', asOf: '2026-11-24T12:00:45Z' };
const lane = (source: FleetReplicaSource, name: string, goal: string): OrgTreeLane => ({
  lane: name, machine: source.machine ?? undefined, source, provider: 'Anthropic', model: null, state: 'unknown',
  doing: 'Waiting for a report', heldReason: null, running: null, target: null, queued: null, held: null, health: null,
  usage: { usedPct: null, asOf: null, resetAt: null }, jobs: [{
    id: goal, repo: null, model: null, provider: 'Anthropic', status: 'running', tier: null, ageSeconds: null,
    goal, state: 'running', doing: 'Running', startedAt: null, prUrl: null, lastEvent: null, lastActivityAt: null,
  }],
});

function Fixture({ source = pro }: { source?: FleetReplicaSource }) {
  const [value, select] = useState('');
  const tree = { ...fleetOrgTree(fleetOrgMap(null, { now })), source, lanes: [
    lane(pro, 'Claude', 'Pro agent'), lane(muse, 'Gemini Neon', 'Muse agent'),
  ], peerSources: [muse, { ...muse, machine: 'Air' }] };
  return <FleetMachineScope now={now} live={null} scope={{ machine: value || null, select, tree, scopedLive: null }} />;
}

it('starts merged, labels the lanes, and filters lanes and agents by machine', () => {
  render(<Fixture />);
  const lanes = screen.getByRole('list', { name: 'Machine lanes' });
  expect(within(lanes).getByText('Pro · leader replica · 2s ago')).toBeVisible();
  expect(within(lanes).getByText('Muse · leader replica · 15s ago')).toBeVisible();
  const picker = screen.getByRole('combobox', { name: 'Fleet machine' });
  expect(picker).toHaveValue('');
  fireEvent.change(picker, { target: { value: 'Muse' } });
  expect(screen.getByText('Muse agent · Running')).toBeVisible();
  expect(screen.getByText(/Running count unknown/)).toBeVisible();
  expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  expect(screen.queryByText('Pro agent · Running')).not.toBeInTheDocument();
});

it('offers a machine with no lane observations without reporting zero', () => {
  render(<Fixture />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Fleet machine' }), { target: { value: 'Air' } });
  expect(screen.getByText('Air · leader replica · 15s ago')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('No lane observations reported for this selection.');
  expect(screen.queryByRole('list', { name: 'Machine lanes' })).not.toBeInTheDocument();
});

it('renders the stale reason instead of displaying stale lane and agent data', () => {
  render(<Fixture source={{ ...pro, stale: true, reason: 'leader unreachable since noon' }} />);
  expect(screen.getByText('Pro · leader replica · 2s ago · Stale: leader unreachable since noon')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('leader unreachable since noon');
  expect(screen.queryByRole('list', { name: 'Machine lanes' })).not.toBeInTheDocument();
});
