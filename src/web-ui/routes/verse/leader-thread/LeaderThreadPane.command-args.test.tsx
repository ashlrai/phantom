import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch, type RouteAnswer } from '../command/fetch-stub.test-support.js';
import { LIVE_SESSIONS_API } from '../fleet-sessions/sessions-model.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { MAC_APPS_API } from './composer-app-commands.js';
import { macApps } from './composer-apps.test-support.js';
import { assistSessions } from './composer-assist.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const LANES_API = '/api/verse/fleet/control/lanes';
const row = (lane: string, held: boolean, heldReason: string | null = null) => ({ lane, target: 3, floor: 0, ceiling: 6, held, heldReason, heldUntil: null, lastChange: null, changedBy: null });
const lanes: LaneTargetsV1 = { v: 1, generatedAt: '2026-11-20T12:00:00Z', sourceState: 'healthy',
  lanes: [row('claude', false), row('codex-personal', true, 'quota reset pending'), row('glm', true, 'provider outage')] };

// The reply box keeps its unsent draft in localStorage, so each test starts without the last one's text.
beforeEach(() => { evictAll(); window.localStorage.clear(); clearMutationToken(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function setup(routes: Record<string, RouteAnswer | null> = {}) {
  const net = stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
    [LANES_API]: lanes,
    [LIVE_SESSIONS_API]: assistSessions(),
    [MAC_APPS_API]: macApps(),
    ...routes,
  } });
  render(<LeaderThreadPane visible />);
  await screen.findByText('Hello from the Leader.');
  const input = screen.getByRole('textbox', { name: 'Reply to the Leader' }) as HTMLTextAreaElement;
  const reads = (path: string) => net.fetchMock.mock.calls.filter(([url]) => String(url).split('?')[0] === path).length;
  return { net, input, reads };
}

/** Types into the reply box with the caret at the end, as a keyboard would leave it. */
function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

const names = (list: HTMLElement) => within(list).getAllByRole('option').map(option => option.querySelector('strong')!.textContent);

describe('Leader reply box: filling in a command’s argument', () => {
  it('lists the held lanes once /release waits for one, and Enter fills in the first', async () => {
    const { net, input } = await setup();
    type(input, '/release');
    expect(screen.queryByRole('listbox')).toBeNull();

    type(input, '/release ');
    const list = await screen.findByRole('listbox', { name: 'Held lanes' });
    expect(names(list)).toEqual(['codex-personal', 'glm']);
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveTextContent('quota reset pending');
    expect(options[0]).toHaveAttribute('data-tone', 'warn');
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/release codex-personal');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(net.posted).toEqual([]);
  });

  it('moves with the arrows, and Enter then writes the highlighted session instead of running the command', async () => {
    const { net, input } = await setup();
    type(input, '/thread RQ-');
    const list = await screen.findByRole('listbox', { name: 'Sessions' });
    const second = names(list)[1]!;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue(`/thread ${second}`);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(net.posted).toEqual([]);
  });

  it('runs a typed argument as typed on Enter, even while the list offers a longer match', async () => {
    const { input } = await setup();
    type(input, '/log RQ-QUI');
    expect(names(await screen.findByRole('listbox', { name: 'Jobs' }))).toEqual(['RQ-QUIET']);
    fireEvent.keyDown(input, { key: 'Enter' });
    // The job id in the answer is a button, so the line is read as a whole.
    await waitFor(() => expect(document.querySelector('[data-composer-result]')).toHaveTextContent(/^Opened the live log for RQ-QUI\./));
    expect(input).toHaveValue('');
  });

  it('runs /thread on Enter when the session after @ is typed in full, even with the @ list open', async () => {
    const { net, input } = await setup();
    type(input, '/thread @RQ-CODEX');
    await screen.findByRole('listbox', { name: 'Running sessions' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('[data-composer-result]')).toHaveTextContent('Opened the conversation with RQ-CODEX (running, codex-local).'));
    expect(input).toHaveValue('');

    // A part of the id is still completed, not run.
    type(input, '/thread @RQ-COD');
    await screen.findByRole('listbox', { name: 'Running sessions' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/thread @RQ-CODEX ');
    expect(net.posted).toEqual([]);
  });

  it('reads the apps only once /app waits for one; Tab fills in the match by its id, and a click does the same', async () => {
    const { input, reads } = await setup();
    type(input, '/app');
    expect(reads(MAC_APPS_API)).toBe(0);
    type(input, '/app saf');
    const list = await screen.findByRole('listbox', { name: 'Mac apps' });
    expect(within(list).getByRole('option')).toHaveTextContent('Safarirunning, 800 MBbrings it to the front');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/app safari');
    expect(reads(MAC_APPS_API)).toBe(1);

    type(input, '/app ');
    fireEvent.click(within(await screen.findByRole('listbox', { name: 'Mac apps' })).getByText('Cursor'));
    expect(input).toHaveValue('/app cursor');
  });

  it('/hold lists every lane and leaves room for the minutes', async () => {
    const { input } = await setup();
    type(input, '/hold ');
    const list = await screen.findByRole('listbox', { name: 'Lanes' });
    expect(names(list)).toEqual(['claude', 'codex-personal', 'glm']);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/hold claude ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Esc closes the list and keeps the draft; typing again reopens it', async () => {
    const { net, input } = await setup();
    type(input, '/stop ');
    await screen.findByRole('listbox', { name: 'Running jobs' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('/stop ');
    expect(net.posted).toEqual([]);
    type(input, '/stop R');
    expect(await screen.findByRole('listbox', { name: 'Running jobs' })).toBeInTheDocument();
  });

  it('says the list is unavailable, never that nothing is held, when the server does not serve it', async () => {
    const { input } = await setup({ [LANES_API]: null, [MAC_APPS_API]: null });
    type(input, '/release ');
    expect(await screen.findByText('Lanes unavailable. This server does not list them. You can still type a lane name.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    // With no row to fill in, Enter is the command's own: it asks for the lane.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('/release needs a lane: /release <lane>')).toBeInTheDocument();

    type(input, '/app ');
    await waitFor(() => expect(screen.getByText(/^Apps unavailable\. .* You can still type an app name\.$/)).toBeInTheDocument());
  });

  it('says when no lane is held', async () => {
    const { input } = await setup({ [LANES_API]: { ...lanes, lanes: [row('claude', false)] } });
    type(input, '/release ');
    expect(await screen.findByText('No lane is held right now.')).toBeInTheDocument();
  });
});
