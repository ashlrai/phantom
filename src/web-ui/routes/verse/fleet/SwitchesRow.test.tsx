import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { SwitchesRow } from './SwitchesRow.js';
import { evictAll } from '../../../data/cache.js';
import { FleetControl } from './FleetControl.js';
import { fleetControl } from '../command/fixtures.test-support.js';
import { SWITCHES_PATH } from './switches-queries.js';
const token = 'a'.repeat(64);
const fixture = (on = true) => ({ v: 1, sourceState: 'healthy', switches: [
  { id: 'PAUSE', on, since: '2026-10-31T12:00:00Z', effect: '' },
  { id: 'ORCH_OFF', on: false, since: null, effect: '' },
] });
const view = (visible = true) => <SectionVisibilityProvider visible={visible}><SwitchesRow /></SectionVisibilityProvider>;
function stub(status = 200) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json(status === 200 ? fixture(false) : { error: 'Switch refused.' }, { status }) : Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { evictAll(); setMutationToken(token); });
afterEach(() => { vi.useRealTimers(); clearMutationToken(); vi.unstubAllGlobals(); });
it('reads PAUSE on and only changes after the POST read-back', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json(fixture())));
  vi.stubGlobal('fetch', fetcher);
  render(view());
  await screen.findByText('1 on: Pause launches');
  const pause = screen.getByRole('switch', { name: 'Pause launches' });
  expect(pause).toBeChecked();
  expect(pause).toHaveAccessibleDescription('no new launches');
  fireEvent.click(pause);
  expect(pause).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Leaders off' })).toBeDisabled();
  expect(screen.getByText('Updating switches…')).toBeInTheDocument();
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe(SWITCHES_PATH);
  expect(JSON.parse(String(post[1]!.body))).toEqual({ id: 'PAUSE', on: false });
  expect(new Headers(post[1]!.headers).get('x-ashlr-token')).toBe(token);
  await act(async () => { finish(Response.json(fixture(false))); });
  expect(pause).not.toBeChecked();
  expect(screen.getByText('All clear')).toBeInTheDocument();
});
it('confirms on and allows cancellation before posting', async () => {
  const fetcher = stub(); render(view());
  await screen.findByText('1 on: Pause launches');
  fireEvent.click(screen.getByRole('switch', { name: 'Leaders off' }));
  expect(screen.getByText('Turn on Leaders off? stops leader passes.')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Leaders off' }));
  fireEvent.click(screen.getByRole('button', { name: 'Turn on Leaders off' }));
  await screen.findByText('All clear');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({ id: 'ORCH_OFF', on: true });
  expect(screen.getByRole('switch', { name: 'Leaders off' })).not.toBeChecked();
});
it('renders read-only with the Leaders unlock copy', async () => {
  clearMutationToken(); const fetcher = stub(); render(view());
  await screen.findByText('1 on: Pause launches');
  expect(screen.getByText('Unlock actions with the mutation token before chatting.')).toBeInTheDocument();
  const pause = screen.getByRole('switch', { name: 'Pause launches' });
  expect(pause).toBeDisabled(); fireEvent.click(pause);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it.each([400, 409, 423])('retains state and shows server refusal %s', async status => {
  stub(status); render(view()); await screen.findByText('1 on: Pause launches');
  fireEvent.click(screen.getByRole('switch', { name: 'Pause launches' }));
  await screen.findByText('Switch refused.');
  expect(screen.getByRole('switch', { name: 'Pause launches' })).toBeChecked();
});
it('stops polling after 404 until reopened', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }));
  vi.stubGlobal('fetch', fetcher); const rendered = render(view());
  await act(async () => {});
  expect(screen.getByText('Switches are not in this build yet.')).toBeInTheDocument();
  rendered.rerender(view()); await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetcher).toHaveBeenCalledTimes(1);
  rendered.rerender(view(false)); rendered.rerender(view()); await act(async () => {});
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('polls every ten seconds only while visible', async () => {
  vi.useFakeTimers(); const fetcher = stub(); const rendered = render(view());
  await act(async () => {}); await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  rendered.rerender(view(false)); await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the existing Fleet facts and adds Switches', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path === SWITCHES_PATH ? fixture() : fleetControl('live'))));
  render(<SectionVisibilityProvider visible><FleetControl
    actions={{ act: vi.fn(), busy: false, error: null, clearError: vi.fn(), readOnly: false, dialogs: null }}
    grantFlow={{ open: vi.fn(), sheet: null }} /></SectionVisibilityProvider>);
  await screen.findByText('1 on: Pause launches');
  for (const label of ['Agents', 'Grant', 'Spend today', 'Daemon', 'Custody', 'Switches']) {
    expect(screen.getAllByText(label).some(node => node.closest('dt'))).toBe(true);
  }
});
