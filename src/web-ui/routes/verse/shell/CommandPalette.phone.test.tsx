import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { palettePhoneQuery } from './palette-phone-query.js';
import { setShellNotifier } from './run-command.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
const url = 'https://phantom.example/verse/m';
const notify = vi.fn();
let gateway: 'running' | 'not-running';
let missing: boolean;
let phoneUrl: string | null;
function Harness() {
  const ui = useVerseUi();
  return ui.overlay === 'palette' ? <CommandPalette /> : null;
}
beforeEach(() => {
  localStorage.clear(); evictAll(); resetVerseUi();
  gateway = 'running'; missing = false; phoneUrl = url; notify.mockClear(); setShellNotifier(notify);
  const net = shellFetch(activity());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/verse/fleet/control/remote-phone') {
      return missing ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({
        v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway, phoneUrl,
        publicOrigin: 'https://phantom.example', pending: 1, devices: { active: 2, revoked: 0 },
      }));
    }
    return net.fetch(input, init);
  }));
  resetActivityForTest(path => net.fetch(path).then((response: Response) => response.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource);
});
afterEach(() => { setShellNotifier(null); resetActivityForTest(); vi.unstubAllGlobals(); });

async function searchPhone() {
  const user = userEvent.setup({ delay: null });
  render(<Harness />);
  act(() => openVerseOverlay('palette'));
  await user.type(await screen.findByRole('combobox', { name: 'Search commands' }), 'phone');
  return user;
}

it('copies the phone URL with Enter and reports success', async () => {
  const user = await searchPhone();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  const option = await screen.findByRole('option', { name: /Copy phone URL.*gateway running · 2 phones paired · 1 waiting for you/ });
  await waitFor(() => expect(option).toHaveAttribute('aria-selected', 'true'));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Phone URL copied', 'success'));
}, 15000);

it('copies an available URL even when the gateway is stopped', async () => {
  gateway = 'not-running';
  const user = await searchPhone();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  const option = await screen.findByRole('option', { name: /Copy phone URL.*gateway not running/ });
  await user.click(option);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
});

it('opens the phone URL in a new tab', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const user = await searchPhone();
  await user.click(await screen.findByRole('option', { name: /Open phone URL/ }));
  expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  open.mockRestore();
});

it('does not list phone commands when the URL is null', async () => {
  phoneUrl = null;
  await searchPhone();
  await waitFor(() => expect(getQuerySnapshot(palettePhoneQuery.key).data).toMatchObject({ phoneUrl: null }));
  expect(screen.queryByRole('option', { name: /Copy phone URL|Open phone URL/ })).not.toBeInTheDocument();
});

it('does not list the phone command when the route is absent', async () => {
  missing = true;
  await searchPhone();
  await waitFor(() => expect(getQuerySnapshot(palettePhoneQuery.key).data).toEqual({ kind: 'notInBuild' }));
  expect(screen.getByText('Nothing matches “phone”.')).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Copy phone URL|Open phone URL/ })).not.toBeInTheDocument();
});
