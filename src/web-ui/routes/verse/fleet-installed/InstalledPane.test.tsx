import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PluginsPane, SkillsPane } from './InstalledPane.js';

const state = vi.hoisted(() => ({ status: 'success' as 'success' | 'error' | 'loading', key: '' }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (query: { key: string }) => {
    state.key = query.key;
    if (state.status !== 'success') return { status: state.status, data: undefined };
    return { status: 'success', data: { schema: 'fleet.plugins-panel.v1', observedAt: '2026-11-17T12:00:00Z',
      sources: [{ source: 'Phantom', state: 'read', count: 1 }, { source: 'Claude Code', state: 'unknown', count: 0 }],
      items: [{ name: 'scan', source: 'Phantom', agents: 'Any agent that runs phm on this machine', enabled: 'unknown', lastUsed: 'unknown' }] } };
  },
  useRefetch: () => vi.fn(),
}));
beforeEach(() => { state.status = 'success'; });
const props = { visible: true } as Parameters<typeof PluginsPane>[0];

it('renders plugin rows and unreadable sources as unknown', () => {
  render(<PluginsPane {...props} />);
  expect(state.key).toBe('fleet-plugins-panel');
  expect(screen.getByText('scan')).toBeTruthy();
  expect(screen.getByText('Phantom · Any agent that runs phm on this machine · Last used: unknown')).toBeTruthy();
  expect(screen.getByText('Enabled: unknown')).toBeTruthy();
  expect(screen.getByText('Claude Code: unknown (could not read)')).toBeTruthy();
  expect(screen.getByText('phm plugins list --all --json')).toBeTruthy();
});

it('reads skills from the skills route and says unknown when it cannot load', () => {
  state.status = 'error';
  render(<SkillsPane {...props} />);
  expect(state.key).toBe('fleet-skills-panel');
  expect(screen.getByRole('alert').textContent).toBe('Skills: unknown (could not load). Refresh to try again.');
});
