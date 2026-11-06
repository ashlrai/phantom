import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { RunsSwitches } from './RunsSwitches.js';

const ids = ['ORCH_OFF', 'OPUS_LEADER_OFF', 'PAUSE', 'PUBLISH_HOLD', 'HOLD', 'QUEUE_DISABLE'];
const rows = ids.map((id, i) => ({ id, on: i === 2 || i === 3, since: null, effect: `Effect ${i}` }));
const healthy = { v: 1, switches: rows, sourceState: 'healthy' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('RunsSwitches', () => {
  it('renders running state and applies only the server readback after a token-authorized write', async () => {
    const token = 'a'.repeat(64);
    setMutationToken(token);
    let finish!: (response: Response) => void;
    const fetcher = vi.fn((_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(json(healthy)));
    vi.stubGlobal('fetch', fetcher);
    render(<RunsSwitches />);
    const group = await screen.findByRole('group', { name: 'Fleet switches' });
    expect(within(group).getAllByRole('switch')).toHaveLength(6);
    expect(within(group).getByText('2 switches off: Launches, Publishing')).toBeInTheDocument();
    const launches = within(group).getByRole('switch', { name: 'Launches' });
    expect(launches).toHaveAttribute('aria-checked', 'false');
    expect(within(group).getByRole('switch', { name: 'Queue' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(launches);
    expect(launches).toBeDisabled();
    expect(launches).toHaveAttribute('aria-checked', 'false');
    const [, request] = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(request?.headers).toMatchObject({ 'x-ashlr-token': token });
    expect(JSON.parse(String(request?.body))).toEqual({ id: 'PAUSE', on: false });
    await act(async () => finish(json({ ...healthy, switches: rows.map(row => row.id === 'PAUSE' ? { ...row, on: false } : row) })));
    expect(launches).toHaveAttribute('aria-checked', 'true');
    expect(launches).not.toBeDisabled();
  });

  it('does not let a pre-write poll overwrite the returned state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setMutationToken('c'.repeat(64));
    let finishPoll!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(json({ ...healthy, switches: rows.map(row => row.id === 'QUEUE_DISABLE' ? { ...row, on: true } : row) }));
      return ++reads === 1 ? Promise.resolve(json(healthy)) : new Promise<Response>(resolve => { finishPoll = resolve; });
    }));
    render(<RunsSwitches />);
    const queue = await screen.findByRole('switch', { name: 'Queue' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await act(async () => { fireEvent.click(queue); });
    expect(queue).toHaveAttribute('aria-checked', 'false');
    await act(async () => finishPoll(json(healthy)));
    expect(queue).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the server failure without changing the switch', async () => {
    setMutationToken('b'.repeat(64));
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => Promise.resolve(init?.method === 'POST'
      ? json({ error: 'The flag could not be written.' }, 409) : json(healthy))));
    render(<RunsSwitches />);
    const control = await screen.findByRole('switch', { name: 'Queue' });
    fireEvent.click(control);
    expect(await screen.findByRole('status')).toHaveTextContent('The flag could not be written.');
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a missing directory without toggles', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ ...healthy, sourceState: 'missing' }))));
    render(<RunsSwitches />);
    expect(await screen.findByText('No fleet runs directory on this Mac.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('polls only while the section is visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetcher = vi.fn(() => Promise.resolve(json(healthy)));
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(<SectionVisibilityProvider visible><RunsSwitches /></SectionVisibilityProvider>);
    await screen.findByRole('switch', { name: 'Queue' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    rerender(<SectionVisibilityProvider visible={false}><RunsSwitches /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the route is absent', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetcher = vi.fn(() => Promise.resolve(json({}, 404)));
    vi.stubGlobal('fetch', fetcher);
    render(<RunsSwitches />);
    expect(await screen.findByText('Switches are not in this build yet.')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
