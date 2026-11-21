import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { LEADER_HEALTH_API } from '../leader-thread/leader-health-model.js';
import { SessionWallPane, WallView } from './SessionWall.js';
import { findEntries, narrowSessionWall, NO_SCOPE, scopeChoices, sessionWallQuery, sessionWallQueryFor, wallPath, type WallScope } from './session-wall-model.js';
import { barNote } from './WallBar.js';
import { forgetWallSeen, noteWallSeen, unseenCount } from './wall-seen.js';
import { takeRequestedWallSession } from './wall-selection.js';
import { forgetWallView } from './wall-view-store.js';

const AT = '2026-11-20T12:00:00.000Z';
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'worker', agent: 'claude', lane: 'claude', model: 'fixture-model', repo: 'phantom',
  jobId: id, parentId: 'leader', state: 'running', lastMessageAgeSeconds: 120, prUrl: null, ...over });
const message = (key: string, side: string, label: string, text: string) => ({ key, kind: key.split(':')[0], side, label, at: null, text, format: 'plain' });
const entry = (s: Record<string, unknown>, summary: string, messages: unknown[] = []) => ({ session: s, summary: [summary], messageCount: messages.length, gaps: [], messages });

const ALL = [
  entry(session('leader', { kind: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null, parentId: null, state: 'idle' }), 'leader is the leader.',
    [message('owner:1', 'other', 'Mason', 'Ship the wall today.')]),
  entry(session('RQ-A'), 'RQ-A is a worker on claude.', [message('latest', 'session', 'RQ-A', 'Running the web suite now.')]),
  entry(session('RQ-B', { lane: 'codex', repo: 'verse-site', state: 'quiet' }), 'RQ-B is a worker on codex.', [message('latest', 'session', 'RQ-B', 'Waiting on the build.')]),
  entry(session('RQ-C', { lane: 'codex', state: 'done' }), 'RQ-C finished.', [message('step:1', 'record', 'Step 1', 'Opened the pull request')]),
];
const scopeOf = (url: URL): WallScope => ({ lane: url.searchParams.get('lane'), repo: url.searchParams.get('repo'), live: url.searchParams.get('live') === '1' });
/** The route's own narrowing: lane and repo match exactly, `live` drops finished sessions; the leader stays unless a filter is set. */
function answer(scope: WallScope, over: Record<string, unknown> = {}) {
  const threads = ALL.filter(({ session: s }) => (!scope.lane || s.lane === scope.lane) && (!scope.repo || s.repo === scope.repo) && (!scope.live || s.state !== 'done'));
  return { schema: 'fleet.session-threads.v1', generatedAt: AT, filter: scope, counts: { sessions: threads.length }, threads, gaps: [], ...over };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function serve(wall: (scope: WallScope) => unknown = scope => answer(scope)) {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => json(wall(scopeOf(new URL(String(input), 'http://localhost')))));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
/** Every path asked for, once each. The wall also reads whether the Leader is passing (the notice above the cards), once, whatever is narrowed. */
const asked = (fetch: ReturnType<typeof serve>) => [...new Set(fetch.mock.calls.map(call => String(call[0])))];
const read = (over: Record<string, unknown> = {}) => narrowSessionWall(answer(NO_SCOPE, over))!;
const shownIds = () => within(screen.getByRole('list', { name: 'Conversations' })).getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent);
const findBox = () => screen.getByRole('searchbox', { name: 'Find in the conversations on screen' });
const mount = () => render(<SessionWallPane visible host={{ openPane: vi.fn() } as never} />);

beforeEach(() => { evictAll(); forgetWallSeen(); forgetWallView(); setMutationToken('a'.repeat(64)); takeRequestedWallSession(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearMutationToken(); });

describe('the wall read for one scope', () => {
  it('asks the bare path unscoped and names each filter once', () => {
    expect(wallPath(NO_SCOPE)).toBe('/api/verse/fleet/control/session-threads');
    expect(wallPath({ lane: 'codex', repo: 'verse-site', live: true })).toBe('/api/verse/fleet/control/session-threads?lane=codex&repo=verse-site&live=1');
    expect(sessionWallQueryFor(NO_SCOPE)).toBe(sessionWallQuery);
    expect(sessionWallQueryFor({ ...NO_SCOPE, live: true }).key).toBe('verse-fleet-session-threads:?live=1');
  });

  it('keeps the scope the server says it applied, and none when the read does not say or says something unusable', () => {
    expect(read().scope).toEqual(NO_SCOPE);
    expect(narrowSessionWall(answer({ lane: 'codex', repo: null, live: true }))!.scope).toEqual({ lane: 'codex', repo: null, live: true });
    expect(read({ filter: undefined }).scope).toBeNull();
    expect(read({ filter: { lane: 'two words', repo: null, live: false } }).scope).toBeNull();
    expect(read({ filter: { lane: null, repo: null } }).scope).toBeNull();
  });

  it('offers the lanes and repos seen so far, never "unknown", and keeps them while narrowed', () => {
    const lanes = scopeChoices([], read().entries, 'lane', null);
    expect(lanes).toEqual(['claude', 'codex']);
    expect(scopeChoices([], read().entries, 'repo', null)).toEqual(['phantom', 'verse-site']);
    const narrowed = narrowSessionWall(answer({ lane: 'codex', repo: null, live: false }))!;
    expect(scopeChoices(lanes, narrowed.entries, 'lane', 'codex')).toBe(lanes);
    expect(scopeChoices(lanes, [], 'lane', 'grok')).toEqual(['claude', 'codex', 'grok']);
  });
});

describe('finding among the sessions on screen', () => {
  it('matches every word against id, lane, repo, state, summary and the messages shown', () => {
    const ids = (find: string) => findEntries(read().entries, find).map(e => e.session.id);
    expect(ids('')).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']);
    expect(ids('  CODEX ')).toEqual(['RQ-B', 'RQ-C']);
    expect(ids('codex quiet')).toEqual(['RQ-B']);
    expect(ids('verse-site')).toEqual(['RQ-B']);
    expect(ids('web suite')).toEqual(['RQ-A']);
    expect(ids('ship the wall')).toEqual(['leader']);
    expect(ids('nothing-like-this')).toEqual([]);
  });

  it('shows only the matching cards and counts the state buttons from them', () => {
    render(<WallView read={read()} onOpen={() => {}} find="codex" />);
    expect(shownIds()).toEqual(['RQ-B', 'RQ-C']);
    expect(within(screen.getByRole('group', { name: 'Show sessions by state' })).getAllByRole('button').map(button => button.textContent)).toEqual(['All 2', 'quiet 1', 'done 1']);
    // The headline still counts what the read returned.
    expect(screen.getByText('4 sessions: 1 running, 1 quiet, 1 idle, 1 done')).toBeTruthy();
  });

  it('says nothing matched, where it looked, and how many sessions are not on screen', () => {
    render(<WallView read={read({ counts: { sessions: 52 } })} onOpen={() => {}} find=" zzz " />);
    expect(screen.queryByRole('list', { name: 'Conversations' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('No conversation on screen holds “zzz”. It looks in each session\'s id, lane, model, repo, summary and newest messages; 48 more sessions are not on screen.');
  });

  it('names the scope when the server holds no session in it', () => {
    const scope = { lane: 'grok', repo: null, live: true };
    render(<WallView read={narrowSessionWall(answer(scope))!} onOpen={() => {}} scope={scope} />);
    expect(screen.getByRole('status').textContent).toBe('No sessions in lane grok, running only right now. This keeps asking; "Every session" shows the rest.');
  });
});

describe('the line under the controls', () => {
  it('adds nothing when every session is on screen and nothing is narrowed', () => {
    expect(barNote(read(), NO_SCOPE, '')).toBeNull();
    expect(barNote(null, { ...NO_SCOPE, live: true }, 'x')).toBeNull();
  });

  it('counts matches, and says how to reach sessions the read left out', () => {
    expect(barNote(read({ counts: { sessions: 52 } }), NO_SCOPE, 'codex')).toEqual({ tone: 'plain',
      text: '2 of 4 on screen match · 48 more not on screen: narrow by lane, repo or running to reach them' });
  });

  it('never counts sessions left out when the read did not give a total', () => {
    expect(barNote(read({ counts: undefined }), NO_SCOPE, '')).toBeNull();
  });

  it('names the scope shown, and warns when the read answers for another one', () => {
    const scope = { lane: 'codex', repo: null, live: false };
    expect(barNote(narrowSessionWall(answer(scope))!, scope, '')).toEqual({ tone: 'plain', text: 'Showing lane codex' });
    expect(barNote(read(), scope, '')).toEqual({ tone: 'warn', text: 'The server did not narrow to lane codex; this is every session' });
    expect(barNote(read({ filter: undefined }), scope, '')).toEqual({ tone: 'plain', text: 'Showing lane codex, as asked; the read did not confirm it' });
  });
});

describe('the Conversations pane, narrowed', () => {
  it('puts the cursor in the find box on "/", narrows as words are typed, and hands the keyboard back to the cards', async () => {
    const fetch = serve();
    mount();
    (await screen.findByRole('button', { name: 'RQ-A, running' })).focus();
    fireEvent.keyDown(document.activeElement!, { key: '/' });
    expect(document.activeElement).toBe(findBox());
    fireEvent.change(findBox(), { target: { value: 'codex' } });
    expect(shownIds()).toEqual(['RQ-B', 'RQ-C']);
    expect(within(screen.getByRole('search')).getByRole('status').textContent).toBe('2 of 4 on screen match');
    // Finding asks the server nothing.
    expect(asked(fetch)).toEqual([LEADER_HEALTH_API, '/api/verse/fleet/control/session-threads']);
    fireEvent.keyDown(findBox(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'RQ-B, quiet' }));
    // "/" typed inside the box is a character, not the shortcut.
    findBox().focus();
    expect(fireEvent.keyDown(findBox(), { key: '/' })).toBe(true);
    fireEvent.keyDown(findBox(), { key: 'Escape' });
    expect((findBox() as HTMLInputElement).value).toBe('');
    expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']);
    fireEvent.keyDown(findBox(), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'leader, idle' }));
  });

  it('keeps the words in the find box while a conversation is open', async () => {
    serve(scope => answer(scope));
    mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    fireEvent.change(findBox(), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'RQ-B, quiet' }));
    fireEvent.keyDown(await screen.findByRole('navigation', { name: 'Every session' }), { key: 'Escape' });
    await waitFor(() => expect(shownIds()).toEqual(['RQ-B', 'RQ-C']));
    expect((findBox() as HTMLInputElement).value).toBe('codex');
  });

  it('asks the server for one lane, running only, then every session again, keeping the other lanes on offer', async () => {
    const fetch = serve();
    mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    const lane = screen.getByRole('combobox', { name: 'Lane' }) as HTMLSelectElement;
    expect([...lane.options].map(option => option.textContent)).toEqual(['Any lane', 'claude', 'codex']);
    expect([...(screen.getByRole('combobox', { name: 'Repo' }) as HTMLSelectElement).options].map(option => option.textContent)).toEqual(['Any repo', 'phantom', 'verse-site']);
    expect(screen.queryByRole('button', { name: 'Every session' })).toBeNull();

    fireEvent.change(lane, { target: { value: 'codex' } });
    // The bar stays while the narrowed read is on its way.
    expect(screen.getByText('Reading sessions in lane codex…')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Lane' })).toBe(lane);
    await waitFor(() => expect(shownIds()).toEqual(['RQ-B', 'RQ-C']));
    expect(within(screen.getByRole('search')).getByRole('status').textContent).toBe('Showing lane codex');
    expect([...lane.options].map(option => option.textContent)).toEqual(['Any lane', 'claude', 'codex']);

    fireEvent.click(screen.getByRole('button', { name: 'Running only' }));
    await waitFor(() => expect(shownIds()).toEqual(['RQ-B']));
    expect(screen.getByRole('button', { name: 'Running only' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('search')).getByRole('status').textContent).toBe('Showing lane codex, running only');

    fireEvent.click(screen.getByRole('button', { name: 'Every session' }));
    await waitFor(() => expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']));
    expect(lane.value).toBe('');
    expect(asked(fetch)).toEqual([LEADER_HEALTH_API, '/api/verse/fleet/control/session-threads', '/api/verse/fleet/control/session-threads?lane=codex', '/api/verse/fleet/control/session-threads?lane=codex&live=1']);
  });

  it('says so when the server answers with every session instead of the lane asked for', async () => {
    serve(() => answer(NO_SCOPE));
    mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Lane' }), { target: { value: 'codex' } });
    await waitFor(() => expect(within(screen.getByRole('search')).getByRole('status').textContent).toBe('The server did not narrow to lane codex; this is every session'));
    expect(within(screen.getByRole('search')).getByRole('status').getAttribute('data-tone')).toBe('warn');
    expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']);
  });

  it('keeps the way back on screen when a narrowed read fails', async () => {
    const fetch = vi.fn(async (input: unknown) => (String(input).includes('lane=codex') ? new Response('{"error":"Sessions unavailable."}', { status: 503 }) : json(answer(NO_SCOPE))));
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('button', { name: 'RQ-A, running' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Lane' }), { target: { value: 'codex' } });
    expect((await screen.findByRole('alert')).textContent).toContain('The session list could not be read just now.');
    fireEvent.click(screen.getByRole('button', { name: 'Every session' }));
    await waitFor(() => expect(shownIds()).toEqual(['leader', 'RQ-A', 'RQ-B', 'RQ-C']));
  });
});

it('keeps the new-message marks of sessions a narrowed read leaves out', () => {
  const counted = (id: string, messageCount: number) => ({ session: { id }, messageCount });
  noteWallSeen([counted('RQ-A', 2), counted('RQ-B', 5)], null);
  noteWallSeen([counted('RQ-B', 5)], null, true);
  expect(unseenCount(counted('RQ-A', 4), null)).toBe(2);
  // Unnarrowed, a session missing from the read has left and is forgotten.
  noteWallSeen([counted('RQ-B', 5)], null);
  expect(unseenCount(counted('RQ-A', 4), null)).toBe(0);
});
