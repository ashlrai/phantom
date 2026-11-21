import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SESSION_THREAD_API } from '../fleet-sessions/session-thread-model.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { takeLeaderDraft } from './leader-draft-store.js';
import { LeaderSurface } from './LeaderSurface.js';
import { rosterFleet } from './leader-roster.test-support.js';
import { clampSplit, holdsSession, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN } from './surface-layout.js';
import { forgetSurfaceView, parseSurfaceView, readSurfaceView, SURFACE_VIEW_KEY, writeSurfaceView } from './surface-view-store.js';

beforeEach(() => { evictAll(); window.localStorage.clear(); forgetSurfaceView(); takeLeaderDraft(); takeRequestedWorkerLogJob(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.body.dataset.verseResizing; });

/** Any session as GET /api/verse/fleet/control/session-thread answers it (fleet.session-thread.v1), saying its own id. */
const conversation = (id: string) => ({
  schema: 'fleet.session-thread.v1', generatedAt: '2026-11-17T12:00:00.000Z', id,
  session: { id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: id, parentId: 'leader',
    state: 'running', startedAt: '2026-11-17T11:30:00.000Z', ageSeconds: 1800, lastMessageAt: '2026-11-17T11:58:00.000Z', lastMessageAgeSeconds: 120,
    prUrl: null, computer: 'node-here', helpers: { below: 0, running: 0, failed: 0 } },
  summary: [`Worker ${id} on claude.`],
  messages: [{ key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: '2026-11-17T11:58:00.000Z', text: `${id} is running the tests`, format: 'plain' }],
  sources: { sessions: 'available', activity: 'available', bus: 'none', owner: 'none', replies: 'none', orders: 'none' },
  gaps: [],
  reply: { to: 'job', job: id, mention: `@${id}`, hint: `Goes to the Leader inbox aimed at ${id}.` },
});

/** `sessions` is what the live-sessions route answers; a function returning a Response stands for a failed read. */
const serve = (sessions: unknown = rosterFleet()) => stubSurfaceFetch({ routes: {
  [LIVE_SESSIONS_API]: sessions,
  [SESSION_THREAD_API]: (url: string) => new Response(JSON.stringify(conversation(new URL(url, 'http://console.test').searchParams.get('id') ?? 'unknown')),
    { status: 200, headers: { 'Content-Type': 'application/json' } }),
  '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
  '/api/verse/leader/directives': { directives: [] },
} });

const host = () => ({ openPane: vi.fn(), sendToChat: vi.fn(), addToMessage: vi.fn() }) as unknown as PaneHost;

/** jsdom lays nothing out; this gives every element the pane's width, the way a real dock tab would. */
function paneWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
}

/** A pointer event with the two fields the divider reads; jsdom's own PointerEvent support varies. */
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: Element | Window, clientX: number, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => { target.dispatchEvent(event); });
}

async function openBeside(id = 'RQ-A') {
  render(<LeaderSurface visible host={host()} />);
  await screen.findByText('Hello from the Leader.');
  fireEvent.click(await screen.findByRole('button', { name: `Read ${id} as a conversation` }));
  return screen.getByRole('region', { name: `Session ${id}` });
}

const divider = () => screen.getByRole('separator', { name: 'Resize the session conversation' });
const share = (opened: HTMLElement) => opened.closest<HTMLElement>('[data-layout="beside"]')!.style.getPropertyValue('--reading-share');

describe('the pure half of the divider and the kept view', () => {
  it('holds the share inside the percent limits and each side’s minimum column', () => {
    expect(clampSplit(50, 1280)).toBe(50);
    expect(clampSplit(5, 1280)).toBe(SPLIT_MIN);
    expect(clampSplit(95, 1280)).toBe(SPLIT_MAX);
    // 900 px: 340 px is 38 percent, and the chat's 420 px leaves 53.
    expect(clampSplit(5, 900)).toBe(38);
    expect(clampSplit(95, 900)).toBe(53);
    // An unmeasured pane applies the percent limits alone; nonsense is the default.
    expect(clampSplit(95, 0)).toBe(SPLIT_MAX);
    expect(clampSplit(Number.NaN, 1280)).toBe(SPLIT_DEFAULT);
    // Too narrow for both minimum columns: no share fits, so the default stands (the pane covers the chat there anyway).
    expect(clampSplit(50, 700)).toBe(SPLIT_DEFAULT);
  });

  it('reads back only a session id and a share, and nothing from a malformed value', () => {
    const nothing = { session: null, split: SPLIT_DEFAULT };
    expect(parseSurfaceView(null)).toEqual(nothing);
    expect(parseSurfaceView('not json')).toEqual(nothing);
    expect(parseSurfaceView('[1]')).toEqual(nothing);
    expect(parseSurfaceView(JSON.stringify({ session: 'RQ-A', split: 51.6, extra: 'x' }))).toEqual({ session: 'RQ-A', split: 52 });
    expect(parseSurfaceView(JSON.stringify({ session: 'two words', split: 900 }))).toEqual({ session: null, split: SPLIT_MAX });
    expect(parseSurfaceView(JSON.stringify({ session: 'x'.repeat(201), split: '50' }))).toEqual(nothing);
    writeSurfaceView({ split: 50 });
    writeSurfaceView({ session: 'RQ-A' });
    expect(readSurfaceView()).toEqual({ session: 'RQ-A', split: 50 });
  });

  it('finds a session in the list in any state, and not one the list does not hold', () => {
    const list = rosterFleet();
    expect(holdsSession(list, 'RQ-A')).toBe(true);
    expect(holdsSession(list, 'RQ-FAILED')).toBe(true);
    expect(holdsSession(list, 'helper-a')).toBe(true);
    expect(holdsSession(list, 'RQ-NEVER')).toBe(false);
  });
});

describe('the divider between the Leader chat and a session', () => {
  it('moves with the arrow keys, Home, End and Enter, and keeps where it was left', async () => {
    paneWidth(1280);
    serve();
    const opened = await openBeside();
    const line = divider();
    expect(line).toHaveAttribute('aria-valuenow', String(SPLIT_DEFAULT));
    expect(line).toHaveAttribute('aria-orientation', 'vertical');
    expect(share(opened)).toBe('44%');

    fireEvent.keyDown(line, { key: 'ArrowLeft' });
    expect(line).toHaveAttribute('aria-valuenow', '46');
    expect(line).toHaveAttribute('aria-valuetext', 'Session conversation takes 46 percent of the pane');
    expect(share(opened)).toBe('46%');
    expect(readSurfaceView().split).toBe(46);
    fireEvent.keyDown(line, { key: 'ArrowRight', shiftKey: true });
    expect(line).toHaveAttribute('aria-valuenow', '38');
    fireEvent.keyDown(line, { key: 'Home' });
    expect(line).toHaveAttribute('aria-valuenow', String(SPLIT_MIN));
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line).toHaveAttribute('aria-valuenow', String(SPLIT_MIN));
    fireEvent.keyDown(line, { key: 'End' });
    expect(line).toHaveAttribute('aria-valuenow', String(SPLIT_MAX));
    expect(readSurfaceView().split).toBe(SPLIT_MAX);
    fireEvent.keyDown(line, { key: 'Enter' });
    expect(line).toHaveAttribute('aria-valuenow', String(SPLIT_DEFAULT));
    // A key that is not the divider's is left alone, and the conversation is still open.
    fireEvent.keyDown(line, { key: 'a' });
    expect(readSurfaceView()).toEqual({ session: 'RQ-A', split: SPLIT_DEFAULT });
  });

  it('follows a drag, ends it from the window, and Esc puts it back', async () => {
    paneWidth(1280);
    serve();
    const opened = await openBeside();
    const line = divider();

    // 128 px to the left in a 1280 px pane gives the conversation ten more percent.
    pointer('pointerdown', line, 700);
    expect(line).toHaveAttribute('data-dragging', 'true');
    expect(document.body.dataset.verseResizing).toBe('true');
    pointer('pointermove', window, 572);
    expect(share(opened)).toBe('54%');
    // Nothing is kept until the drag ends.
    expect(readSurfaceView().split).toBe(SPLIT_DEFAULT);
    pointer('pointerup', window, 572);
    expect(line).not.toHaveAttribute('data-dragging');
    expect(document.body.dataset.verseResizing).toBeUndefined();
    expect(readSurfaceView().split).toBe(54);
    // A move after the drag ended does nothing.
    pointer('pointermove', window, 300);
    expect(share(opened)).toBe('54%');

    // Dragging far past the limit stops at it; Esc returns to where the drag began and leaves the conversation open.
    pointer('pointerdown', line, 572);
    pointer('pointermove', window, 1200);
    expect(share(opened)).toBe(`${SPLIT_MIN}%`);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(share(opened)).toBe('54%');
    expect(document.body.dataset.verseResizing).toBeUndefined();
    expect(readSurfaceView()).toEqual({ session: 'RQ-A', split: 54 });
    expect(screen.getByRole('region', { name: 'Session RQ-A' })).toBeInTheDocument();

    // The window losing focus ends a drag where it stands; a right-click never starts one.
    pointer('pointerdown', line, 572);
    pointer('pointermove', window, 598);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(document.body.dataset.verseResizing).toBeUndefined();
    expect(readSurfaceView().split).toBe(52);
    pointer('pointerdown', line, 572, 2);
    expect(document.body.dataset.verseResizing).toBeUndefined();

    // Double-click restores the default.
    fireEvent.doubleClick(line);
    expect(share(opened)).toBe('44%');
    expect(readSurfaceView().split).toBe(SPLIT_DEFAULT);
  });

  it('has no divider where the conversation covers the chat', async () => {
    paneWidth(640);
    serve();
    await openBeside();
    expect(screen.queryByRole('separator')).toBeNull();
  });
});

describe('the open conversation across a reload', () => {
  it('reopens beside the chat with the divider where it was, without taking the keyboard from the reply box', async () => {
    paneWidth(1280);
    serve();
    const opened = await openBeside('RQ-PR');
    fireEvent.keyDown(divider(), { key: 'ArrowLeft', shiftKey: true });
    expect(share(opened)).toBe('52%');
    expect(readSurfaceView()).toEqual({ session: 'RQ-PR', split: 52 });
    cleanup();
    evictAll();

    render(<LeaderSurface visible host={host()} />);
    const box = await screen.findByRole('textbox', { name: 'Reply to the Leader' });
    box.focus();
    const again = await screen.findByRole('region', { name: 'Session RQ-PR' });
    expect(await within(again).findByText('RQ-PR is running the tests')).toBeInTheDocument();
    expect(share(again)).toBe('52%');
    expect(screen.getByRole('button', { name: 'Read RQ-PR as a conversation' })).toHaveAttribute('aria-current', 'true');
    expect(document.activeElement).toBe(box);

    // Closing it is also kept: the next load starts on the Leader chat alone.
    fireEvent.click(within(again).getByRole('button', { name: 'Close this conversation' }));
    expect(readSurfaceView().session).toBeNull();
    cleanup();
    evictAll();
    render(<LeaderSurface visible host={host()} />);
    await screen.findByRole('button', { name: 'Read RQ-PR as a conversation' });
    expect(screen.queryByRole('region', { name: /^Session / })).toBeNull();
  });

  it('follows the stepper: the session stepped to is the one a reload returns to', async () => {
    paneWidth(1280);
    serve();
    const opened = await openBeside('RQ-A');
    const stepper = screen.getByRole('navigation', { name: 'Working sessions' });
    await waitFor(() => expect(within(stepper).getByRole('button', { name: 'Next working session' })).toBeEnabled());
    fireEvent.keyDown(opened, { key: ']' });
    const now = screen.getByRole('region', { name: /^Session / }).getAttribute('aria-label')!.replace('Session ', '');
    expect(now).not.toBe('RQ-A');
    expect(readSurfaceView().session).toBe(now);
  });

  it('does not reopen a session the list no longer holds, and forgets it', async () => {
    paneWidth(1280);
    serve();
    writeSurfaceView({ session: 'RQ-LONG-GONE', split: 50 });
    render(<LeaderSurface visible host={host()} />);
    await screen.findByRole('button', { name: 'Read RQ-A as a conversation' });
    await waitFor(() => expect(readSurfaceView().session).toBeNull());
    expect(screen.queryByRole('region', { name: /^Session / })).toBeNull();
    // The divider's place is kept for the next conversation opened.
    expect(readSurfaceView().split).toBe(50);
  });

  it('leaves the question open while the sessions list does not answer', async () => {
    paneWidth(1280);
    serve(() => new Response('{"error":"unreadable"}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
    writeSurfaceView({ session: 'RQ-A' });
    render(<LeaderSurface visible host={host()} />);
    await screen.findByText('Hello from the Leader.');
    await screen.findByText(/Sessions unavailable right now/);
    expect(screen.queryByRole('region', { name: /^Session / })).toBeNull();
    expect(readSurfaceView().session).toBe('RQ-A');
  });

  it('starts a narrow pane on the Leader chat and forgets the kept session', async () => {
    paneWidth(640);
    serve();
    writeSurfaceView({ session: 'RQ-A' });
    render(<LeaderSurface visible host={host()} />);
    await screen.findByRole('button', { name: 'Read RQ-A as a conversation' });
    expect(screen.queryByRole('region', { name: /^Session / })).toBeNull();
    expect(readSurfaceView().session).toBeNull();
    expect(window.localStorage.getItem(SURFACE_VIEW_KEY)).not.toContain('RQ-A');
  });
});
