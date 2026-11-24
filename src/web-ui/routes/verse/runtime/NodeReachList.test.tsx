import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeReachRows, narrowNodes } from './NodeReachList.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
it('renders rows, states and as-of text', () => {
  render(<NodeReachRows now={NOW} nodes={[
    { label: 'fake-node-a', role: 'leader', lastSeenIso: new Date(NOW - 30_000).toISOString(), state: 'reachable' },
    { label: 'fake-node-b', role: 'standby', lastSeenIso: new Date(NOW - 180_000).toISOString(), state: 'stale' },
    { label: 'fake-node-c', role: 'worker', lastSeenIso: null, state: 'unknown' },
  ]} />);
  expect(screen.getByText('reachable')).toBeTruthy();
  expect(screen.getByText('stale')).toBeTruthy();
  expect(screen.getByText('unknown')).toBeTruthy();
  expect(screen.getByText('seen 30s ago')).toBeTruthy();
  expect(screen.getByText('seen 3m ago')).toBeTruthy();
  expect(screen.getByText('no heartbeat yet')).toBeTruthy();
  expect(screen.getByText('fake-node-b (standby)')).toBeTruthy();
});
it('renders nothing without nodes and narrows bad rows', () => {
  const { container } = render(<NodeReachRows now={NOW} nodes={[]} />);
  expect(container.innerHTML).toBe('');
  expect(narrowNodes({ nodes: [{ label: 'fake-node-a', state: 'offline', lastSeenIso: 'x' }, 5] })).toEqual([
    { label: 'fake-node-a', role: 'worker', lastSeenIso: null, state: 'unknown' }]);
});
