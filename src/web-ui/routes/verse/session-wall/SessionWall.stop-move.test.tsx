/**
 * S and M on a card of the Conversations wall: Stop asks first, Move offers
 * the lanes of the fleet read (GET /api/verse/fleet/runs), and both make the
 * call the conversation's own buttons make (POST /api/verse/fleet/runs/control).
 * The card says a recorded request before the wall's read carries it. Only
 * fetch is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { JOB_CONTROL_PATH } from '../fleet-job-log/job-control-action.js';
import { SessionWallPane } from './SessionWall.js';
import { narrowSessionWall } from './session-wall-model.js';
import { LANDED_HOLD_MS, landedHolds, landedOf, moveLanes, steerBusyText, steerMark, steerShown, withLanded } from './wall-steer.js';
import { forgetWallSeen } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const later = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();
const TOKEN = 'a'.repeat(64);
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const stands = (action: string, status: string, lane: string | null = null) => ({ action, lane, status, at: AT });
const entry = (s: Record<string, unknown>, control: unknown = null) => ({ session: s, summary: [`${String(s.id)} summary.`], messageCount: 0, gaps: [], messages: [], control, serves: null });
const LEADER = session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' });
const body = (threads: unknown[], generatedAt = AT) => ({ schema: 'fleet.session-threads.v1', generatedAt, filter: { lane: null, repo: null, live: false }, counts: { sessions: threads.length }, threads, gaps: [] });
const read = (threads: unknown[], generatedAt = AT) => narrowSessionWall(body(threads, generatedAt))!;
const lane = (name: string, running: number, target: number, held = false, queued = 0) =>
  ({ lane: name, running, target, queued, held, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const LANES = [lane('claude', 1, 2), lane('codex', 0, 2, false, 3), lane('held-lane', 0, 2, true), lane('full-lane', 2, 2), lane('grok', 1, 4)];
const RUNS = { ...fleetRunsFixture({ workers: [], lanes: LANES }), claudeLane: null };

const card = (id: string) => screen.getByRole('list', { name: 'Conversations' }).querySelector<HTMLButtonElement>(`button[data-card="${id}"]`)!;
const press = (id: string, key: string) => { card(id).focus(); fireEvent.keyDown(card(id), { key }); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** Serves the wall, the fleet read (`runs`; a number is that HTTP status) and a control POST, whose receipt `answer` can change. */
function serve(wall: { current: unknown[] }, answer: (asked: { id: string; action: string; lane?: string }) => Record<string, unknown> = () => ({}), runs: unknown = RUNS) {
  const posts: unknown[] = [];
  const asked = { runs: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === JOB_CONTROL_PATH) {
      const ask = JSON.parse(String(init?.body)) as { id: string; action: string; lane?: string };
      posts.push(ask);
      return json({ schema: 'fleet.job.control.v1', action: ask.action, job: ask.id, lane: ask.lane ?? null, status: 'requested', reason: null, requestId: 'jc-0123456789ab', at: AT, dryRun: false, duplicate: false, ...answer(ask) });
    }
    if (url.pathname === '/api/verse/fleet/runs') { asked.runs += 1; return typeof runs === 'number' ? json({ error: 'fleet read failed' }, runs) : json(runs); }
    return json(url.pathname.endsWith('/session-threads') ? body(wall.current) : { error: 'not in this test' });
  }));
  return { posts, asked };
}
const pane = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
const WALL = () => ({ current: [entry(LEADER), entry(session('RQ-A')), entry(session('RQ-B', { lane: 'codex' }))] as unknown[] });

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); takeRequestedWallSession(); setMutationToken(TOKEN); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });

describe('a request the server recorded, before the read carries it', () => {
  const entries = read([entry(LEADER), entry(session('RQ-A')), entry(session('RQ-P'), stands('pause', 'applied'))]).entries;
  const receipt = (over: Record<string, unknown> = {}) => ({ status: 'requested' as const, at: AT, dryRun: false, ...over });

  it('is kept only when something was written', () => {
    const ask = { job: 'RQ-A', action: 'pause' as const };
    expect(landedOf(ask, receipt())).toEqual({ ask, status: 'requested', at: AT });
    expect(landedOf(ask, receipt({ status: 'applied' }))?.status).toBe('applied');
    expect([landedOf(ask, receipt({ status: 'refused' })), landedOf(ask, receipt({ status: 'unknown' })), landedOf(ask, receipt({ dryRun: true }))]).toEqual([null, null, null]);
  });

  it('is written on its own card where the read will write it, and nowhere else', () => {
    const marked = withLanded(entries, [{ ask: { job: 'RQ-A', action: 'move', lane: 'codex' }, status: 'requested', at: AT }, { ask: { job: 'RQ-P', action: 'resume' }, status: 'applied', at: AT }]);
    expect(marked.map(e => steerMark(e)?.text ?? null)).toEqual([null, 'Move to codex requested', null]);
    expect(marked[0]).toBe(entries[0]);
    // An applied resume takes the Paused mark off at once; the read had it still.
    expect(steerMark(entries[2]!)?.text).toBe('Paused');
  });

  it('gives way when the read says it, when the session has left the wall, and when a much newer read still does not say it', () => {
    const mine = { ask: { job: 'RQ-A', action: 'stop' as const }, status: 'requested' as const, at: AT };
    expect(landedHolds(mine, read([entry(session('RQ-A'))]))).toBe(true);
    expect(landedHolds(mine, read([entry(session('RQ-A'), stands('stop', 'requested'))]))).toBe(false);
    expect(landedHolds(mine, read([entry(LEADER)]))).toBe(false);
    expect(landedHolds(mine, read([entry(session('RQ-A'))], later(LANDED_HOLD_MS - 1)))).toBe(true);
    expect(landedHolds(mine, read([entry(session('RQ-A'))], later(LANDED_HOLD_MS)))).toBe(false);
    // A time that cannot be read is no reason to keep saying what the read does not.
    expect(landedHolds({ ...mine, at: 'soon' }, read([entry(session('RQ-A'))]))).toBe(false);
    // A move is shown only by the lane it asked for.
    const moved = read([entry(session('RQ-A'), stands('move', 'requested', 'grok'))]).entries;
    expect([steerShown(moved, { job: 'RQ-A', action: 'move', lane: 'grok' }), steerShown(moved, { job: 'RQ-A', action: 'move', lane: 'codex' })]).toEqual([true, false]);
  });

  it('lists every other lane with what it is running, and why one cannot take the job', () => {
    expect(moveLanes(RUNS.lanes, 'claude')).toEqual([
      { lane: 'codex', blocked: null, text: '0 of 2 running, 3 waiting' },
      { lane: 'held-lane', blocked: 'held', text: 'held, 0 of 2 running' },
      { lane: 'full-lane', blocked: 'full', text: '2 of 2 running, no free slot' },
      { lane: 'grok', blocked: null, text: '1 of 4 running' },
    ]);
    // A session whose lane the list does not name can go to any of them.
    expect(moveLanes(RUNS.lanes, 'unknown')).toHaveLength(5);
    expect([steerBusyText({ job: 'RQ-A', action: 'stop' }), steerBusyText({ job: 'RQ-A', action: 'move', lane: 'grok' })]).toEqual(['Stopping RQ-A…', 'Moving RQ-A to grok…']);
  });
});

describe('S on a card', () => {
  it('asks first, sends nothing on Cancel, and on Yes stops the job and says so on the card at once', async () => {
    const { posts } = serve(WALL());
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    expect(screen.getByText(/S stops it, M moves it to another lane/)).toBeTruthy();
    press('RQ-A', 's');
    const asking = await screen.findByRole('dialog', { name: 'Stop RQ-A?' });
    expect(asking.textContent).toContain('This stops the job’s running processes.');
    fireEvent.click(within(asking).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toHaveLength(0);

    press('RQ-A', 's');
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Stop RQ-A?' })).getByRole('button', { name: 'Yes, stop' }));
    const said = await screen.findByText('Stop requested for RQ-A.');
    expect(said.closest('[role="status"]')?.getAttribute('data-tone')).toBe('waiting');
    expect(posts).toEqual([{ id: 'RQ-A', action: 'stop' }]);
    // The read still has no request for it; the card goes by the receipt.
    await waitFor(() => expect(card('RQ-A').querySelector('[data-tone="asked"]')?.textContent).toBe('Stop requested'));
    expect(card('RQ-B').querySelector('[data-tone]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Paused or asked 1' })).toBeTruthy();
  });

  it('says a refusal in the server\'s words and marks nothing', async () => {
    const { posts } = serve(WALL(), () => ({ status: 'refused', reason: 'RQ-A has already finished.', requestId: null }));
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('RQ-A', 's');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, stop' }));
    expect((await screen.findByText('RQ-A has already finished.')).closest('[role="status"]')?.getAttribute('data-tone')).toBe('refused');
    expect(posts).toHaveLength(1);
    expect(card('RQ-A').querySelector('[data-tone]')).toBeNull();
  });

  it('asks nothing of the Leader, and wants the token before it sends', async () => {
    const { posts } = serve(WALL());
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('leader', 's');
    expect(await screen.findByText('leader has no running job to stop.')).toBeTruthy();
    press('leader', 'm');
    expect(await screen.findByText('leader has no running job to move.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    clearMutationToken();
    press('RQ-A', 's');
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Stop RQ-A?' })).getByRole('button', { name: 'Yes, stop' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Stopping or moving a session requires the mutation token.');
    expect(posts).toHaveLength(0);
  });
});

describe('M on a card', () => {
  it('lists the other lanes, takes the keyboard to the first that can be chosen, and moves the job to the one picked', async () => {
    const { posts, asked } = serve(WALL());
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    // The fleet read is not asked for until M is pressed.
    expect(asked.runs).toBe(0);
    press('RQ-A', 'm');
    const moving = await screen.findByRole('dialog', { name: 'Move RQ-A to another lane' });
    expect(moving.textContent).toContain('It is on claude now.');
    const lanes = await within(moving).findByRole('list', { name: 'Lanes' });
    const rows = within(lanes).getAllByRole('button');
    expect(rows.map(row => [row.querySelector('strong')?.textContent, row.hasAttribute('disabled')])).toEqual([['codex', false], ['held-lane', true], ['full-lane', true], ['grok', false]]);
    expect(rows[1]!.textContent).toContain('held, 0 of 2 running');
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    // Down steps over the lanes that cannot take it; Up at the first stays there.
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[3]);
    fireEvent.keyDown(rows[3]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[3]);
    fireEvent.keyDown(rows[3]!, { key: 'k' });
    expect(document.activeElement).toBe(rows[0]);
    expect(posts).toHaveLength(0);

    fireEvent.click(rows[3]!);
    expect(await screen.findByText('Move to grok requested for RQ-A.')).toBeTruthy();
    expect(posts).toEqual([{ id: 'RQ-A', action: 'move', lane: 'grok' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(card('RQ-A').querySelector('[data-tone="asked"]')?.textContent).toBe('Move to grok requested'));
  });

  it('leaves the job where it is on Cancel, and leaves its own lane out of the list', async () => {
    const { posts } = serve(WALL());
    pane();
    await screen.findByRole('button', { name: 'RQ-B, running' });
    press('RQ-B', 'm');
    const moving = await screen.findByRole('dialog', { name: 'Move RQ-B to another lane' });
    const lanes = await within(moving).findByRole('list', { name: 'Lanes' });
    expect(within(lanes).getAllByRole('button').map(row => row.querySelector('strong')?.textContent)).toEqual(['claude', 'held-lane', 'full-lane', 'grok']);
    fireEvent.click(within(moving).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('says the lanes are unknown when the fleet read fails, and when the server has none', async () => {
    const failed = serve(WALL(), undefined, 500);
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('RQ-A', 'm');
    const moving = await screen.findByRole('dialog', { name: 'Move RQ-A to another lane' });
    expect((await within(moving).findByRole('alert')).textContent).toContain('Lanes unknown: the fleet read did not answer.');
    expect(within(moving).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(moving).queryByRole('list')).toBeNull();
    expect(failed.posts).toHaveLength(0);
    cleanup();
    evictAll();

    serve(WALL(), undefined, 404);
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('RQ-A', 'm');
    expect((await within(await screen.findByRole('dialog')).findByRole('alert')).textContent).toContain('Lanes unknown: this Phantom server has no fleet read.');
  });

  it('says so when every other lane is held or full', async () => {
    serve(WALL(), undefined, { ...RUNS, lanes: [lane('claude', 1, 2), lane('held-lane', 0, 2, true), lane('full-lane', 2, 2)] });
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('RQ-A', 'm');
    const moving = await screen.findByRole('dialog');
    expect(await within(moving).findByText('Every other lane is held or has no free slot, so there is nowhere to move it right now.')).toBeTruthy();
    expect(within(moving).getAllByRole('button').filter(button => !button.hasAttribute('disabled')).map(button => button.textContent)).toEqual(['Cancel']);
  });
});
