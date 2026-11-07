import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn() }));
function Harness() { return useVerseUi().overlay === 'palette' ? <CommandPalette /> : null; }
let status: number;
let reads: number;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); evictAll(); resetVerseUi(); clearMutationToken();
  status = 200; reads = 0;
  const net = shellFetch(activity());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/verse/github/fleet-backlog?')) {
      reads++;
      return new Response(JSON.stringify(status === 200 ? { v: 1, source: 'ok', repo: 'ashlrai/phantom', items: [
        { number: 2461, title: 'bridge: RQ-PHX-FAKE31', job: 'RQ-PHX-FAKE31', mergeStateStatus: 'DIRTY', isDraft: false, suggestedAction: 'recut' },
      ] } : { error: 'unavailable' }), { status });
    }
    return net.fetch(input, init);
  }));
  resetActivityForTest(path => net.fetch(path).then((r: Response) => r.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); markCheckComplete(true);
});
afterEach(() => { act(() => markCheckComplete(false)); resetActivityForTest(); vi.unstubAllGlobals(); });
async function openPalette() {
  act(() => openVerseOverlay('palette'));
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await waitFor(() => expect(reads).toBe(1));
  return input;
}
it('fetches only when open and opens a PR by number with Enter', async () => {
  const open = vi.fn(); vi.stubGlobal('open', open);
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  expect(reads).toBe(0);
  const input = await openPalette();
  await user.type(input, '2461');
  await screen.findByRole('option', { name: /PR #2461 · DIRTY · recut/ });
  await waitFor(() => expect(screen.getByRole('option', { name: /PR #2461/ })).toHaveAttribute('aria-selected', 'true'));
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('https://github.com/ashlrai/phantom/pull/2461', '_blank', 'noopener,noreferrer');
});
it('opens the Merges pane from the backlog summary', async () => {
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  await user.type(await openPalette(), 'backlog');
  const summary = await screen.findByRole('option', { name: /Merge backlog: 1 stuck/ });
  await user.click(summary);
  expect(openDockPane).toHaveBeenCalledWith('fleet-merges');
});
it.each([404, 503])('omits the backlog group on HTTP %i', async code => {
  status = code;
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  await user.type(await openPalette(), 'backlog');
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Merge backlog' })).not.toBeInTheDocument());
});
it('highlights a PR when its delayed read arrives after the query', async () => {
  const net = shellFetch(activity());
  let deliver!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/verse/github/fleet-backlog?')) return new Promise<Response>(resolve => { deliver = resolve; });
    return net.fetch(input, init);
  }));
  const open = vi.fn(); vi.stubGlobal('open', open);
  const user = userEvent.setup({ delay: null }); render(<Harness />);
  act(() => openVerseOverlay('palette'));
  const input = await screen.findByRole('combobox', { name: 'Search commands' });
  await user.type(input, '2461');
  await act(async () => deliver(new Response(JSON.stringify({ v: 1, source: 'ok', repo: 'ashlrai/phantom', items: [
    { number: 2461, title: 'bridge: RQ-PHX-FAKE31', job: 'RQ-PHX-FAKE31', mergeStateStatus: 'DIRTY', isDraft: false, suggestedAction: 'recut' },
  ] }))));
  await waitFor(() => expect(screen.getByRole('option', { name: /PR #2461/ })).toHaveAttribute('aria-selected', 'true'));
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('https://github.com/ashlrai/phantom/pull/2461', '_blank', 'noopener,noreferrer');
});
