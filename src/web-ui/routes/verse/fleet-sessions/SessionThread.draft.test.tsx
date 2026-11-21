import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { SessionThread } from './SessionThread.js';
import { forgetThreadDrafts, hasThreadDraft, keptThreadDraft, MAX_DRAFTS, parseThreadDrafts, reloadThreadDrafts, setThreadDraft, threadDraft, threadSent,
  THREAD_DRAFTS_KEY } from './thread-draft-store.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const AT = new Date(2026, 10, 20, 9, 0, 0).toISOString();
const INBOX = '/api/verse/leader/inbox';

interface Wire { key: string; kind: string; side: string; label: string; at: string | null; text: string; format: string }
const said = (id: string): Wire => ({ key: 'bus:1', kind: 'bus', side: 'session', label: `${id} to leader`, at: AT, text: `${id} is at work`, format: 'plain' });
const owner = (text: string): Wire => ({ key: 'owner:1', kind: 'owner', side: 'other', label: 'Mason', at: AT, text, format: 'plain' });
const body = (id: string, messages: Wire[], state = 'running') => ({
  schema: 'fleet.session-thread.v1', generatedAt: AT, id,
  session: { id, kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: id, parentId: 'leader', state, lastMessageAgeSeconds: 60, prUrl: null },
  summary: ['Worker on claude.'], messages,
  sources: { activity: 'available', bus: 'available', owner: 'none', replies: 'none', orders: 'none' }, gaps: [],
});

/** What each session's read holds beyond its one line, and its state; changed by a test to stand for a later read. */
let extra: Record<string, Wire[]> = {};
let states: Record<string, string> = {};
/** When set, a send waits on it, so a test can move to another conversation while the message is on its way. */
let inboxGate: Promise<void> | null = null;
function serve() {
  const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === INBOX) { if (inboxGate) await inboxGate; return json({ ok: true }); }
    const id = url.searchParams.get('id')!;
    return json(body(id, [said(id), ...(extra[id] ?? [])], states[id]));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const sentToInbox = (fetch: ReturnType<typeof serve>) => fetch.mock.calls.filter(call => String(call[0]).endsWith(INBOX)).map(call => (JSON.parse(String(call[1]?.body)) as { text: string }).text);
const thread = (id: string) => <SessionThread id={id} visible onBack={() => {}} />;
const box = (id: string) => screen.findByRole('textbox', { name: `Message ${id}` }) as Promise<HTMLTextAreaElement>;
const type = (field: HTMLTextAreaElement, value: string) => fireEvent.change(field, { target: { value } });
const waitingLines = () => screen.queryAllByText(/In the Leader's inbox\./);

beforeEach(() => { evictAll(); forgetThreadDrafts(); extra = {}; states = {}; inboxGate = null; setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('a reply started to a session: the kept record', () => {
  it('keeps words under their session, forgets blank ones, and reads only well-formed records back', () => {
    setThreadDraft('RQ-A', 'half a thought', 1_000);
    expect(threadDraft('RQ-A')).toBe('half a thought');
    expect(threadDraft('RQ-B')).toBe('');
    expect(parseThreadDrafts(window.localStorage.getItem(THREAD_DRAFTS_KEY)).get('RQ-A')).toEqual({ text: 'half a thought', at: 1_000 });
    setThreadDraft('RQ-A', '   \n', 2_000);
    expect(hasThreadDraft('RQ-A')).toBe(false);
    expect(window.localStorage.getItem(THREAD_DRAFTS_KEY)).toBeNull();

    const read = parseThreadDrafts(JSON.stringify({ ok: { text: 'kept', at: 5 }, undated: { text: 'kept too', at: 'yesterday' }, blank: { text: '  ', at: 5 }, wrong: 'words', long: { text: 'x'.repeat(7_000), at: 5 } }));
    expect([...read.keys()]).toEqual(['ok', 'undated', 'long']);
    expect(read.get('undated')!.at).toBeNull();
    expect(read.get('long')!.text).toHaveLength(6_000);
    expect(parseThreadDrafts('not json').size).toBe(0);
    expect(parseThreadDrafts('[1]').size).toBe(0);
  });

  it('holds a bounded number of drafts, dropping the one edited longest ago', () => {
    for (let n = 0; n < MAX_DRAFTS; n += 1) setThreadDraft(`RQ-${n}`, `words ${n}`, 1_000 + n);
    setThreadDraft('RQ-NEW', 'one more', 9_000);
    expect(hasThreadDraft('RQ-0')).toBe(false);
    expect(hasThreadDraft('RQ-1')).toBe(true);
    expect(threadDraft('RQ-NEW')).toBe('one more');
  });
});

describe('a reply started to a session: the conversation', () => {
  it('keeps the words with their session when another conversation takes its place, and says so when they come back', async () => {
    serve();
    const view = render(thread('RQ-A'));
    type(await box('RQ-A'), 'stop and revert the last commit');

    view.rerender(thread('RQ-B'));
    const other = await box('RQ-B');
    expect(other.value).toBe('');
    expect(screen.queryByRole('textbox', { name: 'Message RQ-A' })).toBeNull();
    expect(document.querySelector('[data-draft-restored]')).toBeNull();
    type(other, 'a word for B');

    // Back on RQ-A, whose read is still held: its own words, never the ones typed to RQ-B.
    view.rerender(thread('RQ-A'));
    const back = await box('RQ-A');
    expect(back.value).toBe('stop and revert the last commit');
    expect(document.querySelector('[data-draft-restored]')!.textContent).toMatch(/^Draft restored, last edited /);
    type(back, 'stop and revert the last commit, please');
    expect(document.querySelector('[data-draft-restored]')).toBeNull();
    expect(threadDraft('RQ-B')).toBe('a word for B');
  });

  it('keeps a draft across a reload, and sends it to the session it was typed to', async () => {
    const fetch = serve();
    const view = render(thread('RQ-A'));
    type(await box('RQ-A'), 'hold the merge');
    view.unmount(); evictAll(); reloadThreadDrafts();

    render(thread('RQ-A'));
    const again = await box('RQ-A');
    expect(again.value).toBe('hold the merge');
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => expect(sentToInbox(fetch)).toEqual(['@RQ-A hold the merge']));
    await waitFor(() => expect(again.value).toBe(''));
    expect(keptThreadDraft('RQ-A')).toBeNull();
    expect(window.localStorage.getItem(THREAD_DRAFTS_KEY)).toBeNull();
  });

  it('shows a sent line only in the conversation it was sent from, until the read holds the record of it', async () => {
    serve();
    const view = render(thread('RQ-A'));
    const field = await box('RQ-A');
    type(field, 'ship it');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(waitingLines()).toHaveLength(1));

    view.rerender(thread('RQ-B'));
    await box('RQ-B');
    expect(waitingLines()).toHaveLength(0);
    expect(screen.queryByText('@RQ-A ship it')).toBeNull();

    // Opened again later, in a conversation mounted afresh: the line is still waiting there.
    view.unmount();
    const later = render(thread('RQ-A'));
    await box('RQ-A');
    expect(waitingLines()).toHaveLength(1);

    // The next read carries the inbox's own record: the kept copy is dropped, not shown twice.
    later.unmount(); evictAll();
    extra = { 'RQ-A': [owner('@RQ-A ship it')] };
    render(thread('RQ-A'));
    await box('RQ-A');
    expect(screen.getByText('@RQ-A ship it')).toBeTruthy();
    expect(waitingLines()).toHaveLength(0);
    await waitFor(() => expect(threadSent('RQ-A')).toEqual([]));
  });

  it('files a message that lands after another conversation opened under the session it was written to', async () => {
    const fetch = serve();
    let land = () => {};
    inboxGate = new Promise<void>(resolve => { land = resolve; });
    const view = render(thread('RQ-A'));
    const field = await box('RQ-A');
    type(field, 'pause after this step');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(fetch.mock.calls.some(call => String(call[0]).endsWith(INBOX))).toBe(true));

    view.rerender(thread('RQ-B'));
    type(await box('RQ-B'), 'words for B');
    await act(async () => { land(); await inboxGate; await Promise.resolve(); });

    await waitFor(() => expect(threadSent('RQ-A').map(line => line.text)).toEqual(['@RQ-A pause after this step']));
    expect(threadSent('RQ-B')).toEqual([]);
    expect(waitingLines()).toHaveLength(0);
    expect(threadDraft('RQ-A')).toBe('');
    expect((await box('RQ-B')).value).toBe('words for B');
    expect(sentToInbox(fetch)).toEqual(['@RQ-A pause after this step']);
  });

  it('shows the words left for a session that no longer takes a message, and forgets them on Discard', async () => {
    serve();
    setThreadDraft('RQ-A', 'one more thing before you finish');
    states = { 'RQ-A': 'done' };
    render(thread('RQ-A'));
    await screen.findByRole('note');
    expect(screen.queryByRole('textbox')).toBeNull();
    const left = document.querySelector('[data-draft-left="RQ-A"]')!;
    expect(left.textContent).toContain('one more thing before you finish');
    fireEvent.click(screen.getByRole('button', { name: 'Discard the draft' }));
    expect(document.querySelector('[data-draft-left]')).toBeNull();
    expect(hasThreadDraft('RQ-A')).toBe(false);
  });
});
