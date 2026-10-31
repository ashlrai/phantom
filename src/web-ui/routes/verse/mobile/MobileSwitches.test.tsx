/**
 * MobileSwitches.test.tsx — the "Switches on the Mac" card: six rows from
 * the runs snapshot when the control route is not in this build (read-only
 * and it says so), the guarded flip through POST /api/verse/fleet/control/
 * switches when it is (confirm sheet, mutation token, refetched state), the
 * failure path that keeps state and toasts the reason, and the honesty rule
 * that a missing runs dir renders "—", never "off".
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { resetGuard } from '../shell/guard-store.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { MobileSwitches } from './MobileSwitches.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const IDS = ['HOLD', 'PAUSE', 'ORCH_OFF', 'OPUS_LEADER_OFF', 'PUBLISH_HOLD', 'QUEUE_DISABLE'];

function controlResponse(over: Record<string, boolean> = {}) {
  return {
    v: 1,
    sourceState: 'healthy',
    switches: IDS.map((id) => ({ id, on: over[id] ?? false, since: null, effect: `${id} effect` })),
  };
}

/** The card reads only `switches` and `sources.runsDir` — fake fixture values, rest omitted. */
function runsSnapshot(switches: string[] = [], runsDir = 'healthy') {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir, workers: 'healthy', inbox: 'healthy', codex: 'missing', merges: 'healthy' },
    switches,
  };
}

function mount(overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(
    <>
      <MobileSwitches />
      <MobileGuardSheet />
      <MobileToasts />
    </>,
    overrides,
  );
}

beforeEach(() => {
  setMutationToken(TOKEN);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MobileSwitches read-only', () => {
  it('shows six rows from the snapshot when the control route is not in this build', async () => {
    stubFetch({
      'GET /api/verse/fleet/runs': runsSnapshot(['HOLD']),
      // 'GET /api/verse/fleet/control/switches' unstubbed → codeless 404.
    });
    mount();
    const group = await screen.findByRole('group', { name: 'Switches on the Mac' });
    expect(within(group).getByText('Hold all dispatch').closest('div,button')).toHaveTextContent('On');
    expect(within(group).getAllByText('Off')).toHaveLength(5);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(await screen.findByText('Switches can be changed from the Mac in this build.')).toBeInTheDocument();
  });

  it('renders — for every row when the runs dir is missing, never off', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': runsSnapshot([], 'missing') });
    mount();
    const group = await screen.findByRole('group', { name: 'Switches on the Mac' });
    await waitFor(() => expect(within(group).getAllByText('—')).toHaveLength(6));
    expect(within(group).queryByText('Off')).not.toBeInTheDocument();
    expect(within(group).queryByText('On')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('keeps toggles hidden when this device cannot act, even with the control route', async () => {
    stubFetch({
      'GET /api/verse/fleet/runs': runsSnapshot([]),
      'GET /api/verse/fleet/control/switches': controlResponse({ PAUSE: true }),
    });
    mount({ permissions: permissionsFor('unavailable') });
    const group = await screen.findByRole('group', { name: 'Switches on the Mac' });
    await waitFor(() => expect(within(group).getByText('Pause workers').closest('div,button')).toHaveTextContent('On'));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(await screen.findByText(/Your Mac started Phantom without dispatch/)).toBeInTheDocument();
  });
});

describe('MobileSwitches writes', () => {
  it('confirms with the exact wording, then posts {id, on} with the mutation token', async () => {
    let pauseOn = false;
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': () => runsSnapshot([]),
      'GET /api/verse/fleet/control/switches': () => controlResponse({ PAUSE: pauseOn }),
      'POST /api/verse/fleet/control/switches': (body) => {
        pauseOn = body?.['on'] === true;
        return controlResponse({ PAUSE: pauseOn });
      },
    });
    mount();
    const pause = await screen.findByRole('switch', { name: 'Pause workers' });
    expect(pause).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(pause);
    const sheet = await screen.findByRole('alertdialog', { name: 'Pause workers on your Mac?' });
    expect(sheet).toHaveTextContent('Running jobs finish; nothing new starts.');
    expect(stub.posts()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pause workers' }));

    await waitFor(() => expect(stub.posts().map((p) => [p.url, p.body])).toEqual([['/api/verse/fleet/control/switches', { id: 'PAUSE', on: true }]]));
    expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
    expect(await screen.findByRole('switch', { name: 'Pause workers' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText('Workers paused.')).toBeInTheDocument();
  });

  it('turns a switch off too: POST {id, on:false} after its own confirmation', async () => {
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': () => runsSnapshot(['HOLD']),
      'GET /api/verse/fleet/control/switches': () => controlResponse({ HOLD: true }),
      'POST /api/verse/fleet/control/switches': (body) => controlResponse({ HOLD: body?.['on'] === true }),
    });
    mount();
    fireEvent.click(await screen.findByRole('switch', { name: 'Hold all dispatch' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Lift the dispatch hold?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Lift hold' }));
    await waitFor(() => expect(stub.posts()[0]?.body).toEqual({ id: 'HOLD', on: false }));
  });

  it('keeps the state and toasts the reason when the POST fails', async () => {
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': () => runsSnapshot([]),
      'GET /api/verse/fleet/control/switches': () => controlResponse(),
      'POST /api/verse/fleet/control/switches': () => json({ error: 'The switch could not be written.' }, 403),
    });
    mount();
    const pause = await screen.findByRole('switch', { name: 'Pause workers' });
    fireEvent.click(pause);
    const sheet = await screen.findByRole('alertdialog', { name: 'Pause workers on your Mac?' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pause workers' }));

    await waitFor(() => {
      const regions = screen.getAllByRole('status');
      expect(regions.some((r) => r.textContent?.includes('The switch could not be written.'))).toBe(true);
    });
    expect(stub.posts()).toHaveLength(1);
    expect(await screen.findByRole('switch', { name: 'Pause workers' })).toHaveAttribute('aria-checked', 'false');
    for (const region of screen.getAllByRole('status')) {
      expect(region).not.toHaveTextContent(TOKEN);
      expect(region).not.toHaveTextContent('/Users');
    }
  });

  it('polls the two reads every 15 s while visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(json(url === '/api/verse/fleet/control/switches' ? controlResponse() : runsSnapshot([]))));
    vi.stubGlobal('fetch', fetcher);
    mount();
    await screen.findByRole('switch', { name: 'Pause workers' });
    const initial = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const urls = fetcher.mock.calls.slice(initial).map(([url]) => url);
    expect(urls).toContain('/api/verse/fleet/runs');
    expect(urls).toContain('/api/verse/fleet/control/switches');
  });

  it('stops polling the control route once it has answered 404', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(json(url === '/api/verse/fleet/runs' ? runsSnapshot(['HOLD']) : { error: 'not found' }, 404)));
    vi.stubGlobal('fetch', fetcher);
    mount();
    await screen.findByText('Switches can be changed from the Mac in this build.');
    const initial = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const urls = fetcher.mock.calls.slice(initial).map(([url]) => url);
    expect(urls).toContain('/api/verse/fleet/runs');
    expect(urls).not.toContain('/api/verse/fleet/control/switches');
  });
});
