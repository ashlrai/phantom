import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';
import { FleetSection } from '../sections/FleetSection.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';

const token = 'a'.repeat(64);
function stub(status = 201, body: unknown = { at: '2026-10-31T12:00:00Z' }, inbox: unknown[] = []) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json(body, { status }) : Response.json({ inbox }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { evictAll(); setMutationToken(token); });
afterEach(() => { vi.useRealTimers(); clearMutationToken(); vi.unstubAllGlobals(); });

it('types and sends with command-enter, confirms, clears and refreshes', async () => {
  const fetcher = stub();
  const user = userEvent.setup({ delay: null });
  render(<InterjectBox />);
  await screen.findByText('Nothing in the inbox yet.');
  const box = screen.getByRole('textbox');
  await user.type(box, 'Ship when green');
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  await screen.findByText(/^Sent ·/);
  expect(box).toHaveValue('');
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]![0]).toBe('/api/verse/fleet/runs/inbox');
  expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ text: 'Ship when green', source: 'Phantom desktop' });
  expect(new Headers(posts[0]![1]!.headers).get('x-ashlr-token')).toBe(token);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2));
});

it.each([422, 404, 503])('shows the refusal for HTTP %s and retains the draft', async status => {
  stub(status, status === 422 ? { code: 'INBOX_REFUSED', error: 'Secret-shaped text is refused.' } : { error: 'not found' });
  render(<InterjectBox />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(status === 422 ? 'Secret-shaped text is refused.' : 'The inbox API is not in this build yet.');
  expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
  if (status !== 422) expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});

it('uses the Leaders unlock prompt without posting', async () => {
  clearMutationToken();
  const fetcher = stub();
  render(<InterjectBox />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Unlock actions with the mutation token before chatting.');
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('renders only the newest five entries and expands their text', async () => {
  stub(201, {}, Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-31T12:0${i}:00Z`, source: 'Mason', text: `Entry ${i}` })));
  render(<InterjectBox />);
  const list = await screen.findByRole('list');
  expect(within(list).getAllByRole('listitem').map(li => li.firstElementChild?.textContent))
    .toEqual([6, 5, 4, 3, 2].map(i => `2026-10-31T12:0${i}:00Z · Mason`));
  const expand = screen.getByLabelText('Inbox entry 1');
  fireEvent.click(expand);
  expect(expand.closest('details')).toHaveAttribute('open');
});

it('counts past 5000, limits length, preserves plain Enter and clears on Escape', () => {
  stub();
  render(<InterjectBox />);
  const box = screen.getByRole('textbox');
  expect(box).toHaveAttribute('maxlength', '6000');
  fireEvent.change(box, { target: { value: 'x'.repeat(5_001) } });
  expect(screen.getByText('5,001 / 6,000')).toBeInTheDocument();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box).toHaveValue('x'.repeat(5_001));
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(box).toHaveValue('');
});

it('expires the sent status after five seconds', async () => {
  vi.useFakeTimers();
  stub();
  render(<InterjectBox />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(screen.getByText(/^Sent ·/)).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.queryByText(/^Sent ·/)).not.toBeInTheDocument();
});

it('mounts the inbox directly after Fleet control', async () => {
  stubSurfaceFetch({ kind: 'live' });
  render(<FleetSection />);
  const box = screen.getByRole('region', { name: 'Tell the leaders' });
  expect(box.previousElementSibling?.id).toBe('c7-anchor-fleet-control');
});

it('polls every 15 seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = stub();
  const view = render(<SectionVisibilityProvider visible><InterjectBox /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<SectionVisibilityProvider visible={false}><InterjectBox /></SectionVisibilityProvider>);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('disables the composer during sending and ignores composing Enter', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ inbox: [] }))));
  render(<InterjectBox />);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: 'Hello' } });
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true });
  expect(box).toBeEnabled();
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(box).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await act(async () => { finish(Response.json({ at: '2026-10-31T12:00:00Z' })); });
  expect(box).toBeEnabled();
});
