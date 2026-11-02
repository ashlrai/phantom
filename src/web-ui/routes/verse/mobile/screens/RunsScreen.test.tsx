/**
 * Live runs on the phone: a healthy snapshot renders headline, lanes,
 * workers and the Codex meter; nulls are dashes; a 404 is its own honest
 * state (never a crash, never zeros); the composer rides the same guard
 * path as the Leader send — token sheet when the hold has lapsed, then
 * POST, then toast — and a refused send keeps the words and shows why.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { resetBusMissingForTest } from '../bus-query.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { resetFleetRunsMissingForTest } from '../runs-queries.js';
import { refreshRunsScreen, RunsScreen } from './RunsScreen.js';

function healthy(): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { workers: 'healthy' },
    lastTick: '2026-10-31T11:58:00Z',
    paused: false,
    claudeLane: 'healthy',
    lanes: [
      { lane: 'claude', running: 2, target: 2, queued: 1, held: false, heldReason: null },
      { lane: 'codex-personal', running: 0, target: 1, queued: 0, held: true, heldReason: 'HOLD file present' },
    ],
    workers: [{ job: 'phm improve binshield', repo: 'ashlrai/phantom', lane: 'claude', tier: 'elite', ageSeconds: 300 }],
    leaders: [{ label: 'opus-leader', ageSeconds: 600 }],
    mergesLastHour: { count: 3, items: [{ repo: 'ashlrai/phantom', number: 1520, title: 'Bridge notes' }] },
    codexPersonal: { usedPct: 62, resetsAt: '2026-10-31T14:00:00Z', asOf: '2026-10-31T12:00:00Z' },
    inbox: [{ at: '2026-10-31T11:59:00Z', source: 'Phantom mobile', text: 'Ship binshield first' }],
    events: [],
  };
}

function mount(overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(<><RunsScreen /><MobileGuardSheet /><MobileToasts /></>, overrides);
}

// Transform the lazy module during setup, outside the timed interaction.
beforeAll(async () => { await import('../LaneTargetSheet.js'); });
beforeEach(() => setMutationToken(TOKEN));

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetMobileToastsForTest();
  resetFleetRunsMissingForTest();
  resetBusMissingForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RunsScreen reads', () => {
  it('opens the selected lane with server bounds', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': healthy(),
      'GET /api/verse/fleet/control/lanes': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [
        { lane: 'claude', target: 2, floor: 1, ceiling: 7, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null },
      ] } });
    mount();
    fireEvent.click(await screen.findByLabelText('Adjust claude target'));
    const title = await screen.findByText('claude lane target');
    expect(title.closest('[role="dialog"]')).toHaveTextContent('Floor 1 · Ceiling 7');
  });
  it('refreshes targets and live runs after setting a target', async () => {
    let target = 2;
    const control = () => ({ v: 1, generatedAt: '', sourceState: 'healthy', lanes: [
      { lane: 'claude', target, floor: 1, ceiling: 7, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null },
    ] });
    const { calls } = stubFetch({ 'GET /api/verse/fleet/runs': healthy(),
      'GET /api/verse/fleet/control/lanes': control,
      'POST /api/verse/fleet/control/lanes': () => { target = 3; return control(); } });
    mount();
    fireEvent.click(await screen.findByLabelText('Adjust claude target'));
    fireEvent.click(await screen.findByLabelText('Increase target'));
    fireEvent.click(screen.getByText('Set target', { selector: 'button' }));
    const guard = (await screen.findByText('Set claude target to 3?')).closest<HTMLElement>('[role="alertdialog"]');
    expect(guard).not.toBeNull();
    fireEvent.click(within(guard!).getByText('Set target', { selector: 'button' }));
    await waitFor(() => expect(screen.getByLabelText('Adjust claude target')).toHaveTextContent('target 3'));
    expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/verse/fleet/control/lanes')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/verse/fleet/runs')).toHaveLength(2);
  });
  it('keeps lane rows read-only when the control route returns 404', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': healthy() });
    mount();
    await screen.findByText('claude');
    expect(screen.queryByLabelText('Adjust claude target')).not.toBeInTheDocument();
  });
  it('polls targets every ten seconds while visible and stops after a 404', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let missing = false;
    const { calls } = stubFetch({ 'GET /api/verse/fleet/runs': healthy(),
      'GET /api/verse/fleet/control/lanes': () => missing ? json({ error: 'not found' }, 404)
        : { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] } });
    mount();
    await screen.findByLabelText('Adjust claude target');
    missing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await waitFor(() => expect(screen.queryByLabelText('Adjust claude target')).not.toBeInTheDocument());
    const reads = calls.filter((call) => call.url === '/api/verse/fleet/control/lanes').length;
    expect(reads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls.filter((call) => call.url === '/api/verse/fleet/control/lanes')).toHaveLength(reads);
  });
  it('keeps lane rows read-only without action permission', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': healthy(),
      'GET /api/verse/fleet/control/lanes': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] } });
    mount({ permissions: permissionsFor('unavailable') });
    await screen.findByText('claude');
    expect(screen.queryByLabelText('Adjust claude target')).not.toBeInTheDocument();
  });
  it('refreshes both runs and bus data', async () => {
    const bus = { v: 1, hops: [], events: [{ at: '2026-10-31T11:00:00Z', kind: 'launch', text: 'Bus launch' }], sources: { hops: 'healthy', events: 'healthy' } };
    const { calls } = stubFetch({ 'GET /api/verse/fleet/runs': healthy(), 'GET /api/verse/fleet/live/bus': bus });
    mount();
    expect(await screen.findByText('Bus launch')).toBeInTheDocument();
    await refreshRunsScreen();
    expect(calls.filter((call) => call.url === '/api/verse/fleet/runs')).toHaveLength(2);
    expect(calls.filter((call) => call.url === '/api/verse/fleet/live/bus?limit=50')).toHaveLength(2);
  });
  it('shows a skeleton while the snapshot loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    mount();
    expect(screen.getByRole('status', { name: 'Loading live runs' })).toBeInTheDocument();
  });

  it('renders headline, lanes, workers, merges, codex and the inbox tail', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': healthy() });
    mount();
    expect(await screen.findByText('1 running · 3 merged in the last hour')).toBeInTheDocument();
    expect(screen.getByText(/Last tick .* · leaders 10m/)).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('2 running · target 2 · queued 1')).toBeInTheDocument();
    expect(screen.getByText('0 running · target 1 · queued 0 · HOLD file present')).toBeInTheDocument();
    expect(screen.getByText('held')).toBeInTheDocument();
    expect(screen.getByText('phm improve binshield')).toBeInTheDocument();
    expect(screen.getByText('ashlrai/phantom · claude · elite')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
    expect(screen.getByText('Codex (personal)')).toBeInTheDocument();
    expect(screen.getByText('Ship binshield first')).toBeInTheDocument();
    expect(screen.getByText('Phantom mobile')).toBeInTheDocument();
  });

  it('marks paused and a down Claude lane on the headline', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { ...healthy(), paused: true, claudeLane: 'down (HOLD file present)' } });
    mount();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Claude lane down')).toBeInTheDocument();
  });

  it('prints dashes for unknowns, never zeros', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { ...healthy(), mergesLastHour: { count: null, items: [] }, lastTick: null, workers: [{ job: 'w', repo: 'r', lane: 'l', tier: 't', ageSeconds: null }] } });
    mount();
    expect(await screen.findByText('1 running · — merged in the last hour')).toBeInTheDocument();
    expect(screen.getByText(/Last tick —/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('caps workers at forty rows with a +N more line, and says Nothing running when empty', async () => {
    const raw = healthy();
    raw['workers'] = Array.from({ length: 45 }, (_, i) => ({ job: `job-${i}`, repo: 'r', lane: 'l', tier: 't', ageSeconds: 60 }));
    stubFetch({ 'GET /api/verse/fleet/runs': raw });
    mount();
    expect(await screen.findByText('job-39')).toBeInTheDocument();
    expect(screen.queryByText('job-40')).not.toBeInTheDocument();
    expect(screen.getByText('+5 more')).toBeInTheDocument();
  });

  it('says Nothing running when the worker list is empty', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { ...healthy(), workers: [] } });
    mount();
    expect(await screen.findByText('Nothing running')).toBeInTheDocument();
  });

  it('a 404 is not-in-this-build: its own state, and no composer', async () => {
    stubFetch({});
    mount();
    expect(await screen.findByText('Live runs is not in this build yet')).toBeInTheDocument();
    expect(screen.getByText('Update Phantom on your Mac to see the fleet here.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('other failures get the server’s reason and a retry', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': json({ error: 'The runs view is rebuilding.' }, 500) });
    mount();
    expect(await screen.findByText('Couldn’t load live runs')).toBeInTheDocument();
    expect(screen.getByText('The runs view is rebuilding.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('RunsScreen — tell the leaders', () => {
  it('hides the composer on a read-only device, with a note instead', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': healthy() });
    mount({ permissions: permissionsFor('unavailable') });
    expect(await screen.findByText('1 running · 3 merged in the last hour')).toBeInTheDocument();
    expect(screen.getByText('Your Mac started Phantom without dispatch.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('sends through the guard: POST with the token, toast, box cleared, refetch', async () => {
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': healthy(),
      'POST /api/verse/fleet/runs/inbox': json({ ok: true, at: '2026-10-31T12:01:00Z' }, 201),
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'Hold the publish lane' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stub.posts().map((p) => [p.url, p.body])).toEqual([
      ['/api/verse/fleet/runs/inbox', { text: 'Hold the publish lane', source: 'Phantom mobile' }],
    ]));
    expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
    expect(await screen.findByText("Landed in the leaders' inbox")).toBeInTheDocument();
    expect(screen.getByLabelText('Your message')).toHaveValue('');
    await waitFor(() => expect(stub.calls.filter((c) => c.method === 'GET' && c.url === '/api/verse/fleet/runs').length).toBeGreaterThan(1));
  });

  it('a 422 refusal keeps the words and shows the reason', async () => {
    stubFetch({
      'GET /api/verse/fleet/runs': healthy(),
      'POST /api/verse/fleet/runs/inbox': json({ code: 'INBOX_REFUSED', reason: 'Secret-shaped text is refused, not redacted.' }, 422),
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'token is abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Secret-shaped text is refused, not redacted.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your message')).toHaveValue('token is abc');
  });

  it('a 503/404 on the inbox reads as not-in-this-build', async () => {
    stubFetch({
      'GET /api/verse/fleet/runs': healthy(),
      'POST /api/verse/fleet/runs/inbox': json({ code: 'INBOX_UNAVAILABLE' }, 503),
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Live runs is not in this build yet.')).toBeInTheDocument();
  });

  it('a lapsed hold asks for the mutation token first, then sends', async () => {
    clearMutationToken();
    const stub = stubFetch({
      'GET /api/verse/fleet/runs': healthy(),
      'POST /api/verse/fleet/runs/inbox': json({ ok: true, at: '2026-10-31T12:01:00Z' }, 201),
    });
    mount({ permissions: permissionsFor('locked') });
    fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(stub.posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Mutation token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock and send' }));
    await waitFor(() => expect(stub.posts().map((p) => p.url)).toEqual(['/api/verse/fleet/runs/inbox']));
    expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  });
});
