/**
 * What was asked of each session's job, on the Conversations wall: the mark a
 * card and a row carry (`control` on each entry of fleet.session-threads.v1),
 * the "Paused or asked" button, and P, which makes the call the conversation's
 * own Pause and Resume make (POST /api/verse/fleet/runs/control). Only fetch
 * is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JOB_CONTROL_PATH } from '../fleet-job-log/job-control-action.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { SessionWallPane, WallView } from './SessionWall.js';
import { narrowSessionWall } from './session-wall-model.js';
import { steerAsk, steeredEntries, steerMark, steerShown } from './wall-steer.js';
import { forgetWallSeen } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const TOKEN = 'a'.repeat(64);
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const stands = (action: string, status: string, lane: string | null = null) => ({ action, lane, status, at: AT });
const entry = (s: Record<string, unknown>, control: unknown = null) => ({ session: s, summary: [`${String(s.id)} summary.`], messageCount: 0, gaps: [], messages: [], control, serves: null });
const LEADER = session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' });

const THREADS = [
  entry(LEADER, stands('pause', 'applied')),
  entry(session('RQ-A')),
  entry(session('RQ-PAUSED', { state: 'quiet' }), stands('pause', 'applied')),
  entry(session('RQ-ASKED'), stands('pause', 'requested')),
  entry(session('RQ-MOVING', { lane: 'codex' }), stands('move', 'requested', 'claude')),
  entry(session('RQ-RESUMED'), stands('resume', 'applied')),
  entry(session('RQ-OVER', { state: 'done' }), stands('pause', 'applied')),
  entry(session('RQ-ODD'), { action: 'explode', lane: null, status: 'applied' }),
];
const body = (threads: unknown[] = THREADS) => ({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false }, counts: { sessions: threads.length }, threads, gaps: [] });
const read = (threads?: unknown[]) => narrowSessionWall(body(threads))!;
const card = (id: string) => screen.getByRole('list', { name: 'Conversations' }).querySelector<HTMLButtonElement>(`button[data-card="${id}"]`)!;
const shownIds = () => within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent);
const press = (id: string, key: string) => { card(id).focus(); fireEvent.keyDown(card(id), { key }); };

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
/** Serves the wall (whatever `wall.current` holds when asked) and answers a control POST with `answer`, which may change the wall. */
function serve(wall: { current: unknown[] }, answer: (asked: { id: string; action: string }) => Record<string, unknown>) {
  const posts: Array<{ body: unknown; token: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === JOB_CONTROL_PATH) {
      const asked = JSON.parse(String(init?.body)) as { id: string; action: string };
      posts.push({ body: asked, token: new Headers(init?.headers).get('x-phantom-mutation-token') ?? new Headers(init?.headers).get('authorization') });
      return json({ schema: 'fleet.job.control.v1', action: asked.action, job: asked.id, lane: null, status: 'requested', reason: null, requestId: 'jc-0123456789ab', at: AT, dryRun: false, duplicate: false, ...answer(asked) });
    }
    return json(url.pathname.endsWith('/session-threads') ? body(wall.current) : { error: 'not in this test' });
  }));
  return posts;
}
const pane = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); takeRequestedWallSession(); setMutationToken(TOKEN); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });

describe('what stands for each session\'s job', () => {
  it('believes the read only on a session with a job, and marks only what is pending or still in force', () => {
    const entries = read().entries;
    expect(entries.map(e => e.control?.action ?? null)).toEqual([null, null, 'pause', 'pause', 'move', 'resume', 'pause', null]);
    expect(entries.map(e => steerMark(e))).toEqual([null, null, { tone: 'paused', text: 'Paused' }, { tone: 'paused', text: 'Pause requested' },
      { tone: 'asked', text: 'Move to claude requested' }, null, null, null]);
    expect(steeredEntries(entries).map(e => e.session.id)).toEqual(['RQ-PAUSED', 'RQ-ASKED', 'RQ-MOVING']);
    // P resumes while a pause stands and pauses otherwise; a session with no running job is not asked anything.
    expect(entries.map(e => steerAsk(e)?.action ?? null)).toEqual([null, 'pause', 'resume', 'resume', 'pause', 'pause', null, 'pause']);
    expect([steerShown(entries, { job: 'RQ-A', action: 'pause' }), steerShown(entries, { job: 'RQ-PAUSED', action: 'pause' }), steerShown(entries, { job: 'RQ-RESUMED', action: 'resume' })]).toEqual([false, true, true]);
    // A server that predates the field says nothing, which is no mark, not "not paused" in words.
    expect(read([{ session: session('RQ-OLD'), summary: [], messageCount: 0, gaps: [], messages: [] }]).entries[0]!.control).toBeNull();
  });

  it('says it on the card beside the state, and leaves the other cards as they were', () => {
    render(<WallView read={read()} onOpen={() => {}} />);
    expect(card('RQ-PAUSED').querySelector('[data-tone="paused"]')?.textContent).toBe('Paused');
    expect(card('RQ-PAUSED').closest('li')?.getAttribute('data-steer')).toBe('paused');
    expect(card('RQ-MOVING').querySelector('[data-tone="asked"]')?.textContent).toBe('Move to claude requested');
    expect(card('RQ-MOVING').closest('li')?.getAttribute('data-steer')).toBe('asked');
    // The mark is part of what a screen reader hears for the card, ahead of its summary.
    const described = card('RQ-ASKED').getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Pause requested', 'RQ-ASKED summary.']);
    for (const id of ['leader', 'RQ-A', 'RQ-RESUMED', 'RQ-OVER', 'RQ-ODD']) {
      expect(card(id).querySelector('[data-tone]')).toBeNull();
      expect(card(id).closest('li')?.hasAttribute('data-steer')).toBe(false);
    }
    // No P without a way to steer: the line under the cards does not promise it.
    expect(screen.queryByText(/P pauses or resumes/)).toBeNull();
  });

  it('keeps only those sessions behind one button, and draws no button when nothing stands', () => {
    const view = render(<WallView read={read()} onOpen={() => {}} />);
    const only = screen.getByRole('button', { name: 'Paused or asked 3' });
    expect(only.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(only);
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(shownIds()).toEqual(['RQ-PAUSED', 'RQ-ASKED', 'RQ-MOVING']);
    // The last request is applied: the button goes and the wall falls back to every session rather than an empty one.
    view.rerender(<WallView read={read([entry(LEADER), entry(session('RQ-A')), entry(session('RQ-MOVING'), stands('move', 'applied', 'claude'))])} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: /Paused or asked/ })).toBeNull();
    expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-MOVING']);
  });
});

describe('P on a card', () => {
  it('pauses the job, says the receipt, and lets the card take over once the read shows it', async () => {
    const wall = { current: [entry(LEADER), entry(session('RQ-A')), entry(session('RQ-B'))] as unknown[] };
    const answered = { hold: true };
    const posts = serve(wall, () => { if (!answered.hold) wall.current = [entry(LEADER), entry(session('RQ-A'), stands('resume', 'requested')), entry(session('RQ-B'))]; return {}; });
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    expect(screen.getByText(/P pauses or resumes the job of the card the keyboard is on/)).toBeTruthy();
    press('RQ-A', 'p');
    const said = await screen.findByText('Pause requested for RQ-A. P on its card resumes it.');
    expect(said.closest('[role="status"]')?.getAttribute('data-tone')).toBe('waiting');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ id: 'RQ-A', action: 'pause' });
    // The keyboard stays on the card, and the card says the request at once on the receipt's word. The read does not show it yet, so the line stays.
    expect(document.activeElement).toBe(card('RQ-A'));
    await waitFor(() => expect(card('RQ-A').querySelector('[data-tone="paused"]')?.textContent).toBe('Pause requested'));
    expect(screen.getByText('Pause requested for RQ-A. P on its card resumes it.')).toBeTruthy();
    expect(card('RQ-B').querySelector('[data-tone]')).toBeNull();

    // P goes by what the card says, so it resumes. This time the read carries the request, and the line leaves it to the card.
    answered.hold = false;
    press('RQ-A', 'p');
    await waitFor(() => expect(card('RQ-A').querySelector('[data-tone="asked"]')?.textContent).toBe('Resume requested'));
    await waitFor(() => expect(screen.queryByText(/requested for RQ-A/)).toBeNull());
    expect(posts.map(post => post.body)).toEqual([{ id: 'RQ-A', action: 'pause' }, { id: 'RQ-A', action: 'resume' }]);
  });

  it('says a refusal in the server\'s words and keeps it until dismissed', async () => {
    const wall = { current: [entry(LEADER), entry(session('RQ-A'))] as unknown[] };
    serve(wall, () => ({ status: 'refused', reason: 'RQ-A is publishing; it cannot be paused now.', requestId: null }));
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('RQ-A', 'p');
    const said = await screen.findByText('RQ-A is publishing; it cannot be paused now.');
    expect(said.closest('[role="status"]')?.getAttribute('data-tone')).toBe('refused');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('RQ-A is publishing; it cannot be paused now.')).toBeNull();
  });

  it('asks nothing of a session with no running job, and nothing while typing in the find box', async () => {
    const wall = { current: [entry(LEADER), entry(session('RQ-A')), entry(session('RQ-OVER', { state: 'done' }))] as unknown[] };
    const posts = serve(wall, () => ({}));
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('leader', 'p');
    expect(await screen.findByText('leader has no running job to pause or resume.')).toBeTruthy();
    press('RQ-OVER', 'p');
    expect(await screen.findByText('RQ-OVER has no running job to pause or resume.')).toBeTruthy();
    const find = screen.getByRole('searchbox');
    find.focus();
    fireEvent.keyDown(find, { key: 'p' });
    // Modified keys are the browser's and the app's, never a pause.
    card('RQ-A').focus();
    fireEvent.keyDown(card('RQ-A'), { key: 'p', metaKey: true });
    expect(posts).toHaveLength(0);
  });

  it('opens the unlock dialog when no mutation token is held, and sends nothing until it is given', async () => {
    clearMutationToken();
    const wall = { current: [entry(LEADER), entry(session('RQ-A'))] as unknown[] };
    const posts = serve(wall, () => ({}));
    pane();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    press('RQ-A', 'p');
    expect((await screen.findByRole('dialog')).textContent).toContain('Pausing or resuming a session requires the mutation token.');
    expect(posts).toHaveLength(0);
  });
});
