/** Render tests for the palette's Commands group: search, no results, inline run, confirm, copy. */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { requestTerminal } from '../dock/dock-store.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseUiState, openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
vi.mock('../../../components/primitives/clipboard.js', () => ({ copyText: vi.fn(async () => true) }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), requestTerminal: vi.fn() }));
function Harness() { return useVerseUi().overlay === 'palette' ? <CommandPalette /> : null; }
const CLI_FIXTURE = [
  { name: 'tidy', description: 'Show or apply tidy moves.', arguments: ['[--apply]'], changesState: true, needsInput: false },
  { name: 'run show', description: 'Print a past run in detail.', arguments: ['<id>'], changesState: false, needsInput: true },
  { name: 'worklog', description: 'One feed of what the fleet did.', arguments: ['[--hours 6]'], changesState: false, needsInput: false },
];
let runs: string[];
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); evictAll(); resetVerseUi(); clearMutationToken();
  runs = [];
  const net = shellFetch(activity());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/verse/commands') return new Response(JSON.stringify({ schema: 'phantom.commands.v1', commands: CLI_FIXTURE }));
    if (url.startsWith('/api/verse/commands/run?')) {
      runs.push(url);
      return new Response(JSON.stringify({ exitCode: 0, output: 'merged #6708 two minutes ago' }));
    }
    return net.fetch(input, init);
  }));
  resetActivityForTest(path => net.fetch(path).then((r: Response) => r.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); markCheckComplete(true);
});
afterEach(() => { act(() => markCheckComplete(false)); resetActivityForTest(); vi.unstubAllGlobals(); });
async function search(text: string) {
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  act(() => openVerseOverlay('palette'));
  await user.type(await screen.findByRole('combobox', { name: 'Search commands' }), text);
  return user;
}

it('lists a catalog command with its description, and says so when nothing matches', async () => {
  const user = await search('worklog');
  const row = await screen.findByRole('option', { name: /phm worklog/ });
  expect(row).toHaveTextContent('One feed of what the fleet did.');
  expect(screen.getByRole('group', { name: 'Commands' })).toContainElement(row);
  await user.type(screen.getByRole('combobox'), 'zzqx');
  expect(await screen.findByText('Nothing matches “worklogzzqx”.')).toBeInTheDocument();
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  expect(runs).toEqual([]);
});

it('runs a read-only command inline and shows the CLI line to copy', async () => {
  const user = await search('worklog');
  await waitFor(() => expect(screen.getByRole('option', { name: /phm worklog/ })).toHaveAttribute('aria-selected', 'true'));
  await user.keyboard('{Enter}');
  expect(await screen.findByText('merged #6708 two minutes ago')).toBeInTheDocument();
  expect(runs).toEqual(['/api/verse/commands/run?name=worklog']);
  expect(screen.getByRole('group', { name: 'Command' })).toHaveTextContent('phm worklog');
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(copyText).toHaveBeenCalledWith('phm worklog');
  await user.keyboard('{Enter}');
  expect(requestTerminal).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(await screen.findByRole('option', { name: /phm worklog/ })).toBeInTheDocument();
});

it('asks before a state-changing command and runs nothing until confirmed', async () => {
  const user = await search('tidy');
  await waitFor(() => expect(screen.getByRole('option', { name: /phm tidy/ })).toHaveAttribute('aria-selected', 'true'));
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('This changes state. Press Return to put it in the Terminal.');
  expect(runs).toEqual([]);
  expect(requestTerminal).not.toHaveBeenCalled();
  await user.keyboard('{Meta>}c{/Meta}');
  expect(copyText).toHaveBeenCalledWith('phm tidy');
  await user.keyboard('{Enter}');
  expect(requestTerminal).toHaveBeenCalledWith({ paste: 'phm tidy' });
  expect(runs).toEqual([]);
  expect(getVerseUiState()).toMatchObject({ overlay: null, section: 'chat' });
});

it('sends a command that needs input to the Terminal with its arguments spelled out', async () => {
  const user = await search('run show');
  await user.click(await screen.findByRole('option', { name: /phm run show/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This needs input.');
  await user.keyboard('{Enter}');
  expect(requestTerminal).toHaveBeenCalledWith({ paste: 'phm run show <id>' });
  expect(runs).toEqual([]);
});
