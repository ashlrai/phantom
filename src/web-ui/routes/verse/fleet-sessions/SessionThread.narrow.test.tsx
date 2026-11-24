import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, invalidateObserved } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SessionThread, SessionThreadView } from './SessionThread.js';
import { narrowSessionThread, SESSION_THREAD_API } from './session-thread-model.js';
import { chooseView, chosenView, forgetChosenView, isNarrowed, narrowEntries, narrowLine, NOT_NARROWED, nothingLine, shownMark, THREAD_VIEW_KEY, viewCounts,
  viewOfKind } from './thread-narrow.js';
import { forgetThreadRead, THREAD_READ_KEY } from './thread-read-store.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const AT = new Date(2026, 10, 19, 9, 0, 0).toISOString();

interface Wire { key: string; kind: string; side: string; label: string; at: string | null; text: string; format: string }
const entry = (key: string, kind: string, text: string, side = 'session', label = kind): Wire => ({ key, kind, side, label, at: AT, text, format: 'plain' });
const MESSAGES: Wire[] = [
  entry('brief', 'brief', 'Fix the flaky retry test', 'other', 'Brief'),
  entry('step:0', 'step', 'on claude', 'record', 'launched'),
  entry('commands', 'commands', 'npx vitest run retry', 'session', 'Ran 1 command'),
  entry('bus:m1', 'bus', 'Keep the diff small', 'other', 'leader to RQ-A, steer'),
  entry('control:r1', 'control', 'by Mason', 'record', 'Pause asked'),
  entry('latest', 'latest', 'Retry test passes now', 'session', 'Latest'),
];
const body = (messages: Wire[] = MESSAGES) => ({
  schema: 'fleet.session-thread.v1', generatedAt: AT, id: 'RQ-A',
  session: { id: 'RQ-A', kind: 'worker', lane: 'claude', model: 'fixture-model', repo: 'phantom', jobId: 'RQ-A', parentId: 'leader', state: 'running', lastMessageAgeSeconds: 60, prUrl: null },
  summary: ['Worker on claude.'], messages,
  sources: { activity: 'available', bus: 'available', owner: 'none', replies: 'none', orders: 'none' }, gaps: [],
});

const log = () => screen.getByRole('list', { name: 'Conversation with RQ-A' });
const shownKinds = () => [...log().children].map(item => (item.hasAttribute('data-new-mark') ? 'NEW' : item.getAttribute('data-kind')));
const radio = (name: string) => screen.getByRole('radio', { name });
const findBox = () => screen.getByRole('searchbox', { name: 'Find in this conversation' });
const root = () => screen.getByRole('region', { name: 'Session RQ-A' });

async function open(messages: Wire[] | (() => Wire[]) = MESSAGES, onBack = () => {}) {
  stubSurfaceFetch({ routes: { [SESSION_THREAD_API]: () => json(body(typeof messages === 'function' ? messages() : messages)) } });
  render(<SessionThread id="RQ-A" visible onBack={onBack} />);
  await screen.findByRole('search', { name: 'Narrow this conversation' });
}

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); window.localStorage.clear(); forgetChosenView(); forgetThreadRead(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('narrowing a conversation: the model', () => {
  it('files words exchanged under Messages and every other kind, known or not, under Work', () => {
    expect(['order', 'routing', 'brief', 'bus', 'owner', 'reply', 'notes', 'latest', 'sent'].map(viewOfKind)).toEqual(Array(9).fill('said'));
    expect(['step', 'commands', 'files', 'output', 'control', 'something-new'].map(viewOfKind)).toEqual(Array(6).fill('did'));
  });

  it('keeps the entries of the view that hold every find word, in order, and hands back the same list when nothing narrows', () => {
    expect(narrowEntries(MESSAGES, NOT_NARROWED)).toBe(MESSAGES);
    expect(narrowEntries(MESSAGES, { view: 'all', find: '   ' })).toBe(MESSAGES);
    expect(narrowEntries(MESSAGES, { view: 'said', find: '' }).map(m => m.key)).toEqual(['brief', 'bus:m1', 'latest']);
    expect(narrowEntries(MESSAGES, { view: 'did', find: '' }).map(m => m.key)).toEqual(['step:0', 'commands', 'control:r1']);
    // Words match the label as well as the text, in any case, and all of them must be there.
    expect(narrowEntries(MESSAGES, { view: 'all', find: 'RETRY test' }).map(m => m.key)).toEqual(['brief', 'commands', 'latest']);
    expect(narrowEntries(MESSAGES, { view: 'all', find: 'test  FLAKY' }).map(m => m.key)).toEqual(['brief']);
    expect(narrowEntries(MESSAGES, { view: 'all', find: 'steer' }).map(m => m.key)).toEqual(['bus:m1']);
    expect(narrowEntries(MESSAGES, { view: 'did', find: 'retry' }).map(m => m.key)).toEqual(['commands']);
  });

  it('counts what each view would show under the find words', () => {
    expect(viewCounts(MESSAGES, '')).toEqual({ all: 6, said: 3, did: 3 });
    expect(viewCounts(MESSAGES, 'retry')).toEqual({ all: 3, said: 2, did: 1 });
    expect(viewCounts(MESSAGES, 'nowhere')).toEqual({ all: 0, said: 0, did: 0 });
  });

  it('moves the New rule to the first shown entry at or after the marked one', () => {
    const said = narrowEntries(MESSAGES, { view: 'said', find: '' });
    expect(shownMark(MESSAGES, said, 'bus:m1')).toBe('bus:m1');
    expect(shownMark(MESSAGES, said, 'step:0')).toBe('bus:m1');
    expect(shownMark(MESSAGES, narrowEntries(MESSAGES, { view: 'did', find: '' }), 'latest')).toBeNull();
    expect(shownMark(MESSAGES, said, 'gone')).toBeNull();
    expect(shownMark(MESSAGES, said, null)).toBeNull();
  });

  it('says how much is shown only while something is hidden, and why nothing is', () => {
    expect(narrowLine(6, 6, NOT_NARROWED)).toBe('');
    expect(narrowLine(3, 6, { view: 'said', find: '' })).toBe('3 of 6 shown');
    expect(isNarrowed({ view: 'all', find: ' x ' })).toBe(true);
    expect(nothingLine({ view: 'said', find: '' })).toBe('No message is on record for this session.');
    expect(nothingLine({ view: 'did', find: '' })).toBe('No work is on record for this session.');
    expect(nothingLine({ view: 'all', find: ' zebra ' })).toBe('Nothing in this read holds “zebra”.');
    expect(nothingLine({ view: 'did', find: 'zebra' })).toBe('No work on record in this read holds “zebra”.');
  });

  it('keeps the chosen view in storage, forgets Everything, and reads anything else stored as Everything', () => {
    expect(chosenView()).toBe('all');
    chooseView('said');
    expect(window.localStorage.getItem(THREAD_VIEW_KEY)).toBe('said');
    forgetChosenView();
    expect(chosenView()).toBe('said');
    chooseView('all');
    expect(window.localStorage.getItem(THREAD_VIEW_KEY)).toBeNull();
    window.localStorage.setItem(THREAD_VIEW_KEY, 'sideways');
    forgetChosenView();
    expect(chosenView()).toBe('all');
  });
});

describe('narrowing a conversation: the view', () => {
  it('draws no row and shows every entry when the view is rendered without one', () => {
    render(<SessionThreadView thread={narrowSessionThread(body())!} sent={[]} onSent={() => {}} />);
    expect(screen.queryByRole('search')).toBeNull();
    expect(shownKinds()).toEqual(['brief', 'step', 'commands', 'bus', 'control', 'latest']);
  });

  it('shows every entry at first, with the count each view holds, and narrows to messages or work on a click', async () => {
    await open();
    expect(shownKinds()).toEqual(['brief', 'step', 'commands', 'bus', 'control', 'latest']);
    expect(radio('Everything, 6').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('search').hasAttribute('data-narrowed')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Show everything' })).toBeNull();

    fireEvent.click(radio('Messages, 3'));
    expect(shownKinds()).toEqual(['brief', 'bus', 'latest']);
    expect(screen.getByRole('search').hasAttribute('data-narrowed')).toBe(true);
    expect(screen.getByText('3 of 6 shown')).toBeTruthy();

    fireEvent.click(radio('Work, 3'));
    expect(shownKinds()).toEqual(['step', 'commands', 'control']);

    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(shownKinds()).toHaveLength(6);
    expect(screen.queryByText(/of 6 shown/)).toBeNull();
  });

  it('keeps only the entries holding the find words, recounts the views, and says so when none does', async () => {
    await open();
    fireEvent.change(findBox(), { target: { value: 'retry' } });
    expect(shownKinds()).toEqual(['brief', 'commands', 'latest']);
    expect(radio('Messages, 2')).toBeTruthy();
    expect(radio('Work, 1')).toBeTruthy();

    fireEvent.change(findBox(), { target: { value: 'zebra' } });
    expect(screen.queryByRole('list', { name: 'Conversation with RQ-A' })).toBeNull();
    expect(screen.getByText('Nothing in this read holds “zebra”.')).toBeTruthy();
    expect(screen.getByText('0 of 6 shown')).toBeTruthy();
    // The reply box stays: narrowing hides entries, it does not close the conversation.
    expect(screen.getByRole('textbox', { name: 'Message RQ-A' })).toBeTruthy();
  });

  it('takes 1, 2, 3 and / from the conversation but leaves them alone in the reply box', async () => {
    await open();
    fireEvent.keyDown(root(), { key: '2' });
    expect(radio('Messages, 3').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(root(), { key: '3' });
    expect(shownKinds()).toEqual(['step', 'commands', 'control']);
    fireEvent.keyDown(root(), { key: '1' });
    expect(shownKinds()).toHaveLength(6);

    fireEvent.keyDown(root(), { key: '/' });
    expect(document.activeElement).toBe(findBox());

    const reply = screen.getByRole('textbox', { name: 'Message RQ-A' });
    expect(fireEvent.keyDown(reply, { key: '2' })).toBe(true);
    expect(fireEvent.keyDown(reply, { key: '/' })).toBe(true);
    expect(shownKinds()).toHaveLength(6);
    // With a modifier the keys are the browser's.
    expect(fireEvent.keyDown(root(), { key: '2', metaKey: true })).toBe(true);
    expect(shownKinds()).toHaveLength(6);
  });

  it('Esc in the find box clears the words, then hands the keyboard back, and only then closes the conversation', async () => {
    const onBack = vi.fn();
    await open(MESSAGES, onBack);
    findBox().focus();
    fireEvent.change(findBox(), { target: { value: 'retry' } });
    fireEvent.keyDown(findBox(), { key: 'Escape' });
    expect((findBox() as HTMLInputElement).value).toBe('');
    expect(shownKinds()).toHaveLength(6);
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.keyDown(findBox(), { key: 'Escape' });
    expect(document.activeElement).toBe(root());
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.keyDown(root(), { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('opens the next conversation in the view chosen, without the find words', async () => {
    await open();
    fireEvent.click(radio('Work, 3'));
    fireEvent.change(findBox(), { target: { value: 'vitest' } });
    expect(shownKinds()).toEqual(['commands']);
    cleanup();
    evictAll();

    await open();
    expect(radio('Work, 3').getAttribute('aria-checked')).toBe('true');
    expect((findBox() as HTMLInputElement).value).toBe('');
    expect(shownKinds()).toEqual(['step', 'commands', 'control']);
  });

  it('shows an arrival the view holds and counts one it hides', async () => {
    let messages = MESSAGES;
    await open(() => messages);
    fireEvent.click(radio('Messages, 3'));
    messages = [...MESSAGES, entry('step:1', 'step', 'opened a pull request', 'record', 'pr-opened'), entry('bus:m2', 'bus', 'Diff is 40 lines')];
    await act(async () => { invalidateObserved('verse-fleet-session-thread:', true); await Promise.resolve(); });
    await waitFor(() => expect(radio('Messages, 4')).toBeTruthy());
    expect(radio('Work, 4')).toBeTruthy();
    expect(shownKinds()).toEqual(['brief', 'bus', 'latest', 'bus']);
    expect(screen.getByText('4 of 8 shown')).toBeTruthy();
  });

  it('does not record a narrowed conversation as read to its end', async () => {
    chooseView('said');
    await open();
    expect(shownKinds()).toEqual(['brief', 'bus', 'latest']);
    expect(window.localStorage.getItem(THREAD_READ_KEY)).toBeNull();
    fireEvent.keyDown(root(), { key: '1' });
    await waitFor(() => expect(window.localStorage.getItem(THREAD_READ_KEY)).not.toBeNull());
  });

  it('draws the New rule above the first shown entry when the marked one is hidden', () => {
    const narrow = { narrowing: { view: 'said' as const, find: '' }, setView: () => {}, setFind: () => {} };
    render(<SessionThreadView thread={narrowSessionThread(body())!} sent={[]} onSent={() => {}} markKey="step:0" narrow={narrow} />);
    expect(shownKinds()).toEqual(['brief', 'NEW', 'bus', 'latest']);
  });

  it('files a line sent from here under Messages', () => {
    const sent = [{ key: 'sent:1', at: AT, text: '@RQ-A hold the retry change' }];
    const narrow = (view: 'said' | 'did') => ({ narrowing: { view, find: 'retry' }, setView: () => {}, setFind: () => {} });
    const { rerender } = render(<SessionThreadView thread={narrowSessionThread(body())!} sent={sent} onSent={() => {}} narrow={narrow('said')} />);
    expect(shownKinds()).toEqual(['brief', 'latest', 'sent']);
    expect(screen.getByText('3 of 7 shown')).toBeTruthy();
    rerender(<SessionThreadView thread={narrowSessionThread(body())!} sent={sent} onSent={() => {}} narrow={narrow('did')} />);
    expect(shownKinds()).toEqual(['commands']);
  });
});
