import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HostSummary } from '../../../core/web/host-summary.js';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { getVerseUiState, resetVerseUi, setVerseSection } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';

function observation(state: HostSummary['killSwitch']['state'] = 'inactive'): HostSummary {
  return {
    observedAt: '2026-10-26T12:00:00.000Z',
    console: { bindHost: '127.0.0.1', url: 'http://127.0.0.1:4321', loopback: true },
    localInference: { bindHost: '127.0.0.1' },
    killSwitch: { state },
  };
}

beforeEach(() => {
  evictAll();
  resetVerseUi();
  setVerseSection('chat');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sidebar resources', () => {
  it('shows three groups and navigates to the existing sections without any server calls', async () => {
    const { calls } = installFetch(() => json({ error: 'unexpected read' }, 500));
    const user = userEvent.setup();
    render(<SidebarResources />);
    for (const name of ['Agents', 'Routines', 'Machine']) {
      expect(screen.getByRole('region', { name })).toBeVisible();
    }
    await user.click(screen.getByRole('button', { name: 'View agents' }));
    expect(getVerseUiState().section).toBe('agents');
    await user.click(screen.getByRole('button', { name: 'View routines' }));
    expect(getVerseUiState().section).toBe('automations');
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismisses the floating phone sidebar when opening another section', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'View routines' }));
    expect(getVerseUiState()).toMatchObject({ section: 'automations', sidebarCollapsed: true });
  });

  it.each([
    ['active', 'Present — Stop engaged'],
    ['inactive', 'Absent — Stop not engaged'],
    ['unknown', 'Unknown'],
  ] as const)('reads machine facts on demand with %s Stop state', async (state, label) => {
    const { calls } = installFetch(() => json(observation(state)));
    const user = userEvent.setup();
    render(<SidebarResources />);
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    const dialog = await screen.findByRole('dialog', { name: 'This machine' });
    await within(dialog).findByText('http://127.0.0.1:4321');
    expect(within(dialog).getByText('127.0.0.1 (loopback)')).toBeVisible();
    const marker = within(dialog).getByText('Stop marker (~/.ashlr/KILL)');
    expect(marker.nextElementSibling).toHaveTextContent(label);
    expect(within(dialog).getByText('Local inference bind (configured)')).toBeVisible();
    expect(within(dialog).getByText(/does not indicate a running model/)).toBeVisible();
    expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/api/host', method: 'GET' }]);
    expect(getVerseUiState().section).toBe('chat');
  });

  it('keeps missing socket facts unknown and does not claim a non-loopback console is local', async () => {
    const value = observation();
    value.console = { bindHost: null, url: null, loopback: null };
    installFetch(() => json(value));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    await screen.findByText('Absent — Stop not engaged');
    expect(screen.getByText('Console').nextElementSibling).toHaveTextContent('Unknown');
    expect(screen.getByText('Console bind').nextElementSibling).toHaveTextContent('Unknown');
    expect(screen.queryByText('(loopback)', { exact: false })).toBeNull();
  });

  it('reads again on refresh and reopening, and restores keyboard focus on Escape', async () => {
    let state: HostSummary['killSwitch']['state'] = 'inactive';
    const { calls } = installFetch(() => json(observation(state)));
    const user = userEvent.setup();
    render(<SidebarResources />);
    const trigger = screen.getByRole('button', { name: 'This machine' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByText('Absent — Stop not engaged');
    state = 'active';
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Present — Stop engaged');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    state = 'inactive';
    await user.keyboard('{Enter}');
    await screen.findByText('Absent — Stop not engaged');
    expect(calls).toHaveLength(3);
    expect(calls.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('hides an old Stop observation when refresh fails and recovers with another read', async () => {
    let failed = false;
    installFetch(() => failed ? json({ error: 'unavailable' }, 503) : json(observation('active')));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    await screen.findByText('Present — Stop engaged');
    failed = true;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Present — Stop engaged')).toBeNull();
    expect(screen.queryByText('Absent — Stop not engaged')).toBeNull();
    expect(screen.getByText('Stop marker (~/.ashlr/KILL)').nextElementSibling).toHaveTextContent('Unknown');
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Present — Stop engaged');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('withholds the previous clear Stop while a reopened summary waits for its new response', async () => {
    let resolve!: (value: Response) => void;
    const { calls } = installFetch(() => calls.length === 1 ? json(observation())
      : new Promise<Response>((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    await screen.findByText('Absent — Stop not engaged');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    expect(screen.queryByText('Absent — Stop not engaged')).toBeNull();
    expect(screen.getByText('Stop marker (~/.ashlr/KILL)').nextElementSibling).toHaveTextContent('Unknown');
    resolve(json(observation('active')));
    await screen.findByText('Present — Stop engaged');
  });

  it('polls while open and stops making requests after Close', async () => {
    vi.useFakeTimers();
    let state: HostSummary['killSwitch']['state'] = 'inactive';
    const { calls } = installFetch(() => json(observation(state)));
    render(<SidebarResources />);
    fireEvent.click(screen.getByRole('button', { name: 'This machine' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Absent — Stop not engaged')).toBeVisible();
    state = 'active';
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText('Present — Stop engaged')).toBeVisible();
    expect(calls).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls).toHaveLength(2);
  });

  it('cancels a closed opening and ignores its late response after reopening', async () => {
    let finishOldRead!: (value: Response) => void;
    const { calls, fetch } = installFetch(() => calls.length === 1
      ? new Promise<Response>((done) => { finishOldRead = done; }) : json(observation('active')));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    const signal = fetch.mock.calls[0]![1]?.signal;
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(signal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    await screen.findByText('Present — Stop engaged');
    await act(async () => { finishOldRead(json(observation('inactive'))); });
    expect(screen.getByText('Present — Stop engaged')).toBeVisible();
    expect(screen.queryByText('Absent — Stop not engaged')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('shows loading without claiming Stop is clear before the first response', async () => {
    let resolve!: (value: Response) => void;
    installFetch(() => new Promise<Response>((done) => { resolve = done; }));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'This machine' }));
    expect(screen.getByRole('status')).toHaveTextContent('Reading machine status');
    expect(screen.getByText('Stop marker (~/.ashlr/KILL)').nextElementSibling).toHaveTextContent('Unknown');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    resolve(json(observation()));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
