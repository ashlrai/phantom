import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SessionWallPane, WallView } from './SessionWall.js';
import { narrowSessionWall, NO_SCOPE, type WallScope } from './session-wall-model.js';
import { isUnshownGap, unshownNotice } from './wall-unshown.js';
import { forgetWallSeen } from './wall-seen.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-21T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const entry = (id: string, over: Record<string, unknown> = {}) => ({ session: session(id, over), summary: [`${id} is a worker on claude.`], messageCount: 0, gaps: [], messages: [] });
const THREADS = [entry('RQ-A'), entry('RQ-B', { state: 'quiet' })];
/** The read's own sentence for the sessions it left out (session-threads.ts). */
const SAID = '12 more sessions not shown (12 ended): the read holds 40, running sessions first. Narrow it with a lane or repo, or ask for running ones only.';
const OTHER_GAP = 'Bus messages unknown: the agent bus could not be read.';
const wire = (counts: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: NO_SCOPE, counts, threads: THREADS, gaps: [], ...over });
const read = (counts: Record<string, unknown>, over: Record<string, unknown> = {}) => narrowSessionWall(wire(counts, over))!;
const left = (running: number, ended: number, unknown = 0) => ({ sessions: 2 + running + ended + unknown, unshown: { running, ended, unknown } });
const notice = () => document.querySelector<HTMLElement>('[data-unshown]');
const LIVE: WallScope = { lane: null, repo: null, live: true };

describe('what the read left out, as the wall reads it', () => {
  it('believes the three counts only together, and is null from a server that does not send them', () => {
    expect(read(left(1, 4, 2)).unshown).toEqual({ running: 1, ended: 4, unknown: 2 });
    expect(read({ sessions: 9 }).unshown).toBeNull();
    expect(read({ sessions: 9, unshown: { running: 1, ended: 4 } }).unshown).toBeNull();
    expect(read({ sessions: 9, unshown: { running: -1, ended: 4, unknown: 0 } }).unshown).toBeNull();
    expect(read({ sessions: 9, unshown: 'many' }).unshown).toBeNull();
  });

  it('says nothing when every session in the list is on screen, or the list did not say how many it holds', () => {
    expect(unshownNotice(read({ sessions: 2, unshown: { running: 0, ended: 0, unknown: 0 } }), NO_SCOPE)).toBeNull();
    expect(unshownNotice(read({}), NO_SCOPE)).toBeNull();
    expect(unshownNotice({ total: null, entries: [], unshown: { running: 3, ended: 0, unknown: 0 } }, NO_SCOPE)).toBeNull();
  });

  it('is plain when only ended sessions are off screen, and warns when a running one is', () => {
    expect(unshownNotice(read(left(0, 12)), NO_SCOPE)).toEqual({ tone: 'plain', offerRunning: false,
      text: 'Every running session is here. 12 ended sessions are not: the wall holds 2, and a lane or a repo brings them on.' });
    expect(unshownNotice(read(left(0, 1)), NO_SCOPE)!.text).toBe('Every running session is here. 1 ended session is not: the wall holds 2, and a lane or a repo brings them on.');
    expect(unshownNotice(read(left(3, 0)), NO_SCOPE)).toEqual({ tone: 'warn', offerRunning: false,
      text: '3 running sessions are not on this screen. The wall holds 2; a lane or a repo brings them on.' });
    expect(unshownNotice(read(left(1, 4, 2)), NO_SCOPE)!.text).toBe('1 running session is not on this screen, and 4 ended, 2 with state unknown. The wall holds 2; a lane or a repo brings them on.');
    expect(unshownNotice(read(left(0, 4, 2)), NO_SCOPE)).toEqual({ tone: 'warn', offerRunning: false,
      text: '2 sessions with state unknown are not on this screen, and 4 ended. Every session known to be running is here.' });
  });

  it('does not guess for a read that left sessions out without counting them, and offers running only once', () => {
    expect(unshownNotice(read({ sessions: 14 }), NO_SCOPE)).toEqual({ tone: 'warn', offerRunning: true,
      text: '12 sessions are not on this screen, and this read does not say whether any of them is running.' });
    // Asked for running ones only, they are all running, and the same narrowing cannot help again.
    expect(unshownNotice(read({ sessions: 3 }), LIVE)).toEqual({ tone: 'warn', offerRunning: false,
      text: '1 running session is not on this screen. The wall holds 2; a lane or a repo brings them on.' });
  });

  it('knows the read\'s own sentence for it, and no other', () => {
    expect([SAID, '1 more session not shown (1 running): the read holds 40, running sessions first.', '5 more sessions not shown: the read holds 40.'].every(isUnshownGap)).toBe(true);
    expect([OTHER_GAP, '2 earlier bus messages not shown.', 'more sessions not shown'].some(isUnshownGap)).toBe(false);
  });
});

describe('the line under the wall\'s headline', () => {
  afterEach(cleanup);

  it('is absent while the read holds every session, and the foot keeps every gap', () => {
    render(<WallView read={read({ sessions: 2, unshown: { running: 0, ended: 0, unknown: 0 } }, { gaps: [OTHER_GAP] })} onOpen={() => {}} />);
    expect(notice()).toBeNull();
    expect(screen.getByRole('list', { name: 'Not shown' }).textContent).toBe(OTHER_GAP);
  });

  it('says ended sessions are off screen in the plain tone, without a button, and does not repeat the read\'s sentence at the foot', () => {
    render(<WallView read={read(left(0, 12), { gaps: [SAID, OTHER_GAP] })} onOpen={() => {}} onRunningOnly={() => {}} />);
    expect(screen.getByText('2 of 14 sessions: 1 running, 1 quiet')).toBeTruthy();
    expect(notice()!.dataset.tone).toBe('plain');
    expect(notice()!.textContent).toBe('Every running session is here. 12 ended sessions are not: the wall holds 2, and a lane or a repo brings them on.');
    expect(screen.queryByRole('button', { name: 'Running only' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Not shown' }).textContent).toBe(OTHER_GAP);
  });

  it('warns when a running session is off screen, and drops the foot list when that was its only line', () => {
    render(<WallView read={read(left(3, 0), { gaps: [SAID] })} onOpen={() => {}} onRunningOnly={() => {}} />);
    expect(notice()!.dataset.tone).toBe('warn');
    expect(notice()!.textContent).toBe('3 running sessions are not on this screen. The wall holds 2; a lane or a repo brings them on.');
    expect(screen.queryByRole('button', { name: 'Running only' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Not shown' })).toBeNull();
  });

  it('offers Running only for a read that does not count what it left out, only where the wall can narrow', () => {
    const onRunningOnly = vi.fn();
    const { unmount } = render(<WallView read={read({ sessions: 14 })} onOpen={() => {}} onRunningOnly={onRunningOnly} />);
    fireEvent.click(screen.getByRole('button', { name: 'Running only' }));
    expect(onRunningOnly).toHaveBeenCalledTimes(1);
    unmount();
    render(<WallView read={read({ sessions: 14 })} onOpen={() => {}} />);
    expect(notice()!.textContent).toBe('12 sessions are not on this screen, and this read does not say whether any of them is running.');
    expect(screen.queryByRole('button', { name: 'Running only' })).toBeNull();
  });
});

describe('Running only, from the line, in the pane', () => {
  beforeEach(() => { localStorage.clear(); forgetWallView(); forgetWallSeen(); evictAll(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

  it('asks the server for running sessions, and the line goes once the read holds them all', async () => {
    const fetch = vi.fn(async (input: unknown) => {
      const live = new URL(String(input), 'http://localhost').searchParams.get('live') === '1';
      const body = live ? wire({ sessions: 2, unshown: { running: 0, ended: 0, unknown: 0 } }, { filter: LIVE }) : wire({ sessions: 14 });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
    await waitFor(() => expect(notice()).not.toBeNull());
    // The bar has its own Running only switch; this is the one in the line.
    const offered = notice()!.querySelector('button')!;
    expect([offered.textContent, offered.title]).toEqual(['Running only', 'Ask for running sessions only, so the ended ones give up their places']);
    fireEvent.click(offered);
    await waitFor(() => expect(fetch.mock.calls.some(call => String(call[0]).includes('live=1'))).toBe(true));
    await waitFor(() => expect(notice()).toBeNull());
    expect(screen.getByText('2 sessions: 1 running, 1 quiet')).toBeTruthy();
  });
});
