import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { SessionWallPane } from './SessionWall.js';
import { railPreview, railStep } from './SessionRail.js';
import { narrowSessionWall, sessionWallQuery } from './session-wall-model.js';
import { forgetWallSeen, noteWallSeen, unseenCount } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';

const AT = '2026-11-19T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const message = (key: string, side: string, label: string, text: string) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain' });
const sources = { sessions: 'available', activity: 'available', bus: 'none', owner: 'available', replies: 'none', orders: 'none' };
const LEADER = session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle', lastMessageAgeSeconds: null });

/** GET /api/verse/fleet/control/session-threads, with `counts` messages held by each session (CONTRACT.md, "Session threads"). */
function threads(counts: { leader?: number; a?: number } = {}) {
  return {
    schema: 'fleet.session-threads.v1', generatedAt: AT, counts: { sessions: 4 }, gaps: [],
    threads: [
      { session: LEADER, summary: ['leader is the leader.'], messageCount: counts.leader ?? 2, sources, gaps: [],
        messages: [message('owner:1', 'other', 'Mason', 'Ship the wall today.'), message('reply:1', 'session', 'Leader', 'Routed to\n  claude.')] },
      { session: session('RQ-A'), summary: ['RQ-A is a worker on claude.'], messageCount: counts.a ?? 9, sources, gaps: [],
        messages: [message('latest', 'session', 'RQ-A', 'Running the web suite now.'), message('step:4', 'record', 'Step 4', 'Ran the tests')] },
      { session: session('helper-a', { kind: 'subagent', jobId: null, parentId: 'RQ-A', state: 'quiet' }), summary: [], messageCount: 0, sources, gaps: [], messages: [] },
      { session: session('RQ-DONE', { state: 'failed' }), summary: ['RQ-DONE failed.'], messageCount: 1, sources, gaps: [], messages: [message('step:1', 'record', 'Step 1', 'Read the docs')] },
    ],
  };
}
const thread = (id: string) => ({ schema: 'fleet.session-thread.v1', generatedAt: AT, id, session: id === 'leader' ? LEADER : session(id),
  summary: [`${id} summary.`], messages: [message('latest', 'session', id, `Latest from ${id}.`)], sources, gaps: [] });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function serve(wall: () => unknown) {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/inbox')) return json({ ok: true });
    return json(url.pathname.endsWith('/session-thread') ? thread(url.searchParams.get('id')!) : wall());
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const reread = () => act(() => refetchQuery(sessionWallQuery.key, () => sessionWallQuery.fetch(new AbortController().signal), true));
const rail = () => screen.getByRole('navigation', { name: 'Every session' });
const rows = () => within(rail()).getAllByRole('button');
const row = (id: string) => rows().find(button => button.dataset.rail === id)!;
const openRegion = () => screen.getByRole('region').getAttribute('aria-label');
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement!, { key, ...init });

beforeEach(() => { evictAll(); forgetWallSeen(); setMutationToken('a'.repeat(64)); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); });

it('keeps every session listed beside the open conversation and opens another from the list', async () => {
  const fetch = serve(() => threads());
  render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
  expect(within(rail()).getByText('4 sessions: 1 running, 1 quiet, 1 idle, 1 failed')).toBeTruthy();
  expect(rows().map(button => [button.dataset.rail, button.dataset.state, button.getAttribute('aria-current')])).toEqual([
    ['leader', 'idle', null], ['RQ-A', 'running', 'true'], ['helper-a', 'quiet', null], ['RQ-DONE', 'failed', null]]);
  // Each row: when it last spoke (unknown stays unknown), its state, and the newest thing said on one line.
  expect(row('leader').textContent).toBe('leaderunknownidle Leader: Routed to claude.');
  expect(row('RQ-A').textContent).toBe('RQ-A2mrunning RQ-A: Running the web suite now.');
  expect(row('helper-a').textContent).toBe('helper-a2mquiet Nothing recorded yet');
  expect(row('RQ-DONE').textContent).toBe('RQ-DONE2mfailed Step 1: Read the docs');

  fireEvent.click(row('RQ-DONE'));
  expect(openRegion()).toBe('Session RQ-DONE');
  expect(await screen.findByText('Latest from RQ-DONE.')).toBeTruthy();
  expect(fetch.mock.calls.some(call => String(call[0]).includes('/session-thread?id=RQ-DONE'))).toBe(true);
  expect(row('RQ-DONE').getAttribute('aria-current')).toBe('true');
  expect(row('RQ-A').getAttribute('aria-current')).toBeNull();
});

it('steps to the next and previous conversation with J and K, but not while typing a reply', async () => {
  serve(() => threads());
  render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'leader, idle' }));
  // The opened conversation holds the keyboard; J and K work from there with no trip to the list.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region')));
  press('k'); expect(openRegion()).toBe('Session leader');
  press('j'); expect(openRegion()).toBe('Session RQ-A');
  press('j', { metaKey: true }); expect(openRegion()).toBe('Session RQ-A');
  const box = await screen.findByRole('textbox', { name: 'Message RQ-A' });
  fireEvent.keyDown(box, { key: 'j' });
  expect(openRegion()).toBe('Session RQ-A');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region')));
  press('j'); press('j'); press('j');
  expect(openRegion()).toBe('Session RQ-DONE');
  press('k'); expect(openRegion()).toBe('Session helper-a');
});

it('moves through the list with the arrow keys and returns to the wall, on the same card, with Esc', async () => {
  serve(() => threads());
  render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
  fireEvent.click(await screen.findByRole('button', { name: 'RQ-A, running' }));
  row('RQ-A').focus();
  press('ArrowDown'); expect(document.activeElement).toBe(row('helper-a'));
  press('End'); press('ArrowDown'); expect(document.activeElement).toBe(row('RQ-DONE'));
  press('Home'); press('ArrowUp'); expect(document.activeElement).toBe(row('leader'));
  // Moving the cursor opens nothing until Enter (a click).
  expect(openRegion()).toBe('Session RQ-A');
  press('Escape');
  expect(screen.queryByRole('navigation', { name: 'Every session' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'RQ-A, running' })));
});

it('marks what arrived since a conversation was last looked at, on the card and in the list', async () => {
  let counts: { leader?: number; a?: number } = {};
  serve(() => threads(counts));
  render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);
  const card = await screen.findByRole('button', { name: 'RQ-A, running' });
  // The first sight of a session is its starting point: nothing is called new.
  expect(screen.queryByText(/ new$/)).toBeNull();
  counts = { a: 12, leader: 3 };
  await reread();
  expect(await within(card).findByText('3 new')).toBeTruthy();
  expect(card.getAttribute('aria-describedby')!.split(' ')).toContain(within(card).getByText('3 new').id);

  // Open the Leader: its own mark clears, RQ-A keeps its mark in the list beside it.
  fireEvent.click(screen.getByRole('button', { name: 'leader, idle' }));
  expect(within(row('leader')).queryByText(/ new$/)).toBeNull();
  expect(within(row('RQ-A')).getByText('3 new')).toBeTruthy();
  fireEvent.click(row('RQ-A'));
  expect(within(row('RQ-A')).queryByText(/ new$/)).toBeNull();
  // More arrives while it is open: read as it comes, so going back shows no mark for it.
  counts = { a: 14, leader: 3 };
  await reread();
  fireEvent.click(screen.getByRole('button', { name: 'Back to every conversation' }));
  await screen.findByRole('button', { name: 'RQ-A, running' });
  expect(screen.queryByText(/ new$/)).toBeNull();
});

it('counts new messages from the totals alone', () => {
  const entries = narrowSessionWall(threads())!.entries;
  const grown = (count: number) => ({ ...entries[1]!, messageCount: count });
  expect(unseenCount(entries[1]!, null)).toBe(0);
  noteWallSeen(entries, null);
  expect(unseenCount(grown(11), null)).toBe(2);
  expect(unseenCount(grown(11), 'RQ-A')).toBe(0);
  // A later read does not move the starting point; opening the conversation does.
  noteWallSeen([entries[0]!, grown(11)], null);
  expect(unseenCount(grown(12), null)).toBe(3);
  noteWallSeen([entries[0]!, grown(12)], 'RQ-A');
  expect(unseenCount(grown(12), null)).toBe(0);
  // A total that shrank is the new starting point, and a session that left the read starts over when it returns.
  noteWallSeen([entries[0]!, grown(5)], null);
  expect(unseenCount(grown(6), null)).toBe(1);
  noteWallSeen([entries[0]!], null);
  expect(unseenCount(grown(40), null)).toBe(0);
});

it('steps from the read\'s order, and previews the newest line said', () => {
  const read = narrowSessionWall(threads())!;
  expect(railStep(read, 'leader', 1)).toBe('RQ-A');
  expect(railStep(read, 'leader', -1)).toBeNull();
  expect(railStep(read, 'RQ-DONE', 1)).toBeNull();
  // A conversation that is not in the list steps onto the list's near end.
  expect(railStep(read, 'RQ-GONE', 1)).toBe('leader');
  expect(railStep(read, 'RQ-GONE', -1)).toBe('RQ-DONE');
  expect(railStep(null, 'leader', 1)).toBeNull();
  expect(read.entries.map(railPreview)).toEqual(['Leader: Routed to claude.', 'RQ-A: Running the web suite now.', 'Nothing recorded yet', 'Step 1: Read the docs']);
});
