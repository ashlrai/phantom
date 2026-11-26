import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { WallView } from './SessionWall.js';
import { narrowSessionWall } from './session-wall-model.js';
import { requestName, requestTime, requestWords, servedEntries, UNTIED, wallRequests } from './wall-requests-model.js';
import { forgetWallSeen } from './wall-seen.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const entry = (s: Record<string, unknown>, serves: unknown = null) => ({ session: s, summary: [`${String(s.id)} summary.`], messageCount: 0, gaps: [], messages: [], serves });

const WALL = { key: 'desk-7', at: '2026-11-20 09:14', source: 'desktop', text: 'Put every session on one screen.', truncated: false, jobs: 4 };
const DOCS = { key: 'im-3', at: '2026-11-20 10:02', source: 'imessage', text: null, truncated: false, jobs: 1 };

const THREADS = [
  entry(session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' })),
  entry(session('RQ-A'), WALL),
  entry(session('RQ-A-help', { kind: 'subagent', jobId: null, parentId: 'RQ-A', state: 'done' })),
  entry(session('RQ-B', { lane: 'codex', state: 'quiet' }), WALL),
  entry(session('RQ-DOCS', { state: 'done' }), DOCS),
  entry(session('RQ-STANDING', { lane: 'codex' })),
];
const read = (threads: unknown[] = THREADS) => narrowSessionWall({ schema: 'fleet.session-threads.v1', generatedAt: AT, filter: { lane: null, repo: null, live: false },
  counts: { sessions: threads.length }, threads, gaps: [] })!;
const shownIds = () => within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent);
const strip = () => screen.getByRole('region', { name: 'What the owner asked' });
const requestButtons = () => within(strip()).getAllByRole('button').filter(button => button.hasAttribute('data-request'));

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the messages the sessions on screen serve', () => {
  it('reads the tie from each entry and believes it only on a worker, with a key and a time', () => {
    const entries = read().entries;
    expect(entries.map(e => e.serves?.key ?? null)).toEqual([null, 'desk-7', null, 'desk-7', 'im-3', null]);
    expect(entries[4]!.serves).toEqual({ key: 'im-3', at: '2026-11-20 10:02', source: 'imessage', text: null, truncated: false, jobs: 1 });
    const odd = read([
      entry(session('leader', { kind: 'leader', jobId: null, parentId: null }), WALL),
      entry(session('RQ-H', { kind: 'subagent', parentId: 'RQ-X' }), WALL),
      entry(session('RQ-NOKEY'), { ...WALL, key: '' }),
      entry(session('RQ-NOTIME'), { ...WALL, at: 7 }),
      entry(session('RQ-COUNT'), { ...WALL, jobs: 'many', source: 9 }),
      entry(session('RQ-TEXT'), 'desk-7'),
    ]).entries;
    expect(odd.map(e => e.serves?.key ?? null)).toEqual([null, null, null, null, 'desk-7', null]);
    expect([odd[4]!.serves!.jobs, odd[4]!.serves!.source]).toEqual([null, null]);
  });

  it('puts the sessions under their message, newest message first, a helper with its worker and the leader under none', () => {
    const { requests, untied } = wallRequests(read().entries);
    expect(requests.map(r => [r.key, r.sessions, r.workers])).toEqual([['im-3', ['RQ-DOCS'], 1], ['desk-7', ['RQ-A', 'RQ-A-help', 'RQ-B'], 2]]);
    expect(requests[1]!.states).toEqual({ running: 1, quiet: 1, idle: 0, done: 1, failed: 0, unknown: 0 });
    expect(untied).toBe(1);
    expect(wallRequests([])).toEqual({ requests: [], untied: 0 });
  });

  it('says how much of a message\'s routing is on screen, and "unknown" when the read gave no count', () => {
    const [docs, wall] = wallRequests(read().entries).requests as [ReturnType<typeof wallRequests>['requests'][number], ReturnType<typeof wallRequests>['requests'][number]];
    expect(requestWords(wall)).toBe('2 of 4 routed jobs on screen · 1 helper · 1 running, 1 quiet, 1 done');
    expect(requestWords(docs)).toBe('1 routed job · 1 done');
    expect(requestWords({ ...docs, jobs: null })).toBe('1 job on screen, routed jobs unknown · 1 done');
    expect(requestName(wall)).toBe('the owner\'s message of 11-20 09:14 ET from desktop: Put every session on one screen.');
    expect(requestName(docs)).toBe('the owner\'s message of 11-20 10:02 ET from imessage');
    expect([requestTime('2026-11-20 09:14 ET'), requestTime('yesterday')]).toEqual(['11-20 09:14 ET', 'yesterday']);
  });

  it('keeps the sessions under one message, or under none, and everything when the message has left the screen', () => {
    const entries = read().entries, ids = (key: string | null) => servedEntries(entries, key).map(e => e.session.id);
    expect(ids('desk-7')).toEqual(['RQ-A', 'RQ-A-help', 'RQ-B']);
    expect(ids(UNTIED)).toEqual(['RQ-STANDING']);
    expect(ids(null)).toHaveLength(6);
    expect(ids('gone')).toHaveLength(6);
  });
});

describe('"What the owner asked" above the wall', () => {
  const mount = (threads?: unknown[], find = '') => render(<WallView read={read(threads)} onOpen={vi.fn()} find={find} />);

  it('lists each served message with its words, its routing and a last button for sessions citing none', () => {
    mount();
    expect(within(strip()).getByRole('heading', { name: /What the owner asked/ }).textContent).toContain('2 messages have sessions on screen');
    expect(requestButtons().map(button => button.getAttribute('aria-label'))).toEqual([
      'the owner\'s message of 11-20 10:02 ET from imessage (1 routed job · 1 done)',
      'the owner\'s message of 11-20 09:14 ET from desktop: Put every session on one screen. (2 of 4 routed jobs on screen · 1 helper · 1 running, 1 quiet, 1 done)',
      'No message cited: 1 session',
    ]);
    // A message whose words the read does not hold says so instead of showing nothing.
    expect(requestButtons()[0]!.textContent).toContain('Its words are not among the inbox messages this read holds.');
    expect(requestButtons()[1]!.querySelectorAll('[data-state]')).toHaveLength(3);
    expect(requestButtons().every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(shownIds()).toHaveLength(6);
  });

  it('leaves only the sessions serving the chosen message, recounts the state buttons, and gives the rest back', () => {
    mount();
    fireEvent.click(requestButtons()[1]!);
    expect(shownIds()).toEqual(['RQ-A', 'RQ-A-help', 'RQ-B']);
    expect(requestButtons()[1]!.getAttribute('aria-pressed')).toBe('true');
    const states = within(screen.getByRole('group', { name: 'Show sessions by state' })).getAllByRole('button').map(button => button.textContent);
    expect(states).toEqual(['All 3', 'running 1', 'quiet 1', 'done 1']);
    const status = within(strip()).getByRole('status');
    expect(status.textContent).toContain('Showing the 3 sessions serving the owner\'s message of 11-20 09:14 ET; 2 more of its jobs are not on screen. Put every session on one screen.');
    fireEvent.click(within(status).getByRole('button', { name: 'Every session' }));
    expect(shownIds()).toHaveLength(6);
    expect(within(strip()).queryByRole('status')).toBeNull();
    // The same button a second time is also the way back.
    fireEvent.click(requestButtons()[0]!);
    expect(shownIds()).toEqual(['RQ-DOCS']);
    fireEvent.click(requestButtons()[0]!);
    expect(shownIds()).toHaveLength(6);
  });

  it('shows the sessions that cite no message, without the leader', () => {
    mount();
    fireEvent.click(requestButtons()[2]!);
    expect(shownIds()).toEqual(['RQ-STANDING']);
    expect(within(strip()).getByRole('status').textContent).toContain('Showing the session whose job cites none of the owner\'s messages.');
  });

  it('moves along the row with Left, Right, Home and End, and Esc lets go of the chosen message', () => {
    mount();
    const [first, second, last] = requestButtons() as [HTMLElement, HTMLElement, HTMLElement];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'End' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.click(second);
    expect(shownIds()).toHaveLength(3);
    fireEvent.keyDown(second, { key: 'Escape' });
    expect(shownIds()).toHaveLength(6);
  });

  it('counts only the sessions the find box leaves', () => {
    mount(undefined, 'codex');
    expect(requestButtons().map(button => button.getAttribute('aria-label'))).toEqual([
      'the owner\'s message of 11-20 09:14 ET from desktop: Put every session on one screen. (1 of 4 routed jobs on screen · 1 quiet)',
      'No message cited: 1 session',
    ]);
  });

  it('draws nothing when no session on screen serves a message, as with a server that does not say', () => {
    mount(THREADS.map(({ serves: _serves, ...rest }) => rest));
    expect(screen.queryByRole('region', { name: 'What the owner asked' })).toBeNull();
    expect(shownIds()).toHaveLength(6);
  });

  it('goes back to every session when the chosen message\'s last session leaves the read', () => {
    const view = mount();
    fireEvent.click(requestButtons()[0]!);
    expect(shownIds()).toEqual(['RQ-DOCS']);
    view.rerender(<WallView read={read(THREADS.filter(thread => thread.session.id !== 'RQ-DOCS'))} onOpen={vi.fn()} />);
    expect(shownIds()).toHaveLength(5);
    expect(requestButtons().every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(within(strip()).queryByRole('status')).toBeNull();
  });
});
