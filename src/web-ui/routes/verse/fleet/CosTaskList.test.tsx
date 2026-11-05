import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { CosTaskList } from './CosTaskList.js';

const ID = `cos-${'0'.repeat(31)}1`;
const row = { id: ID, jobStatus: 'READY', channel: 'telegram', needsYou: true, delivery: null, hasDraft: true, request: 'Reply to Telegram' };
function stub(handler: (url: string) => Response) {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => handler(String(url)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
it.each([404, 503])('renders nothing when the route is absent (%i)', async status => {
  const fetcher = stub(() => Response.json({}, { status }));
  const { container } = render(<CosTaskList />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});
it('puts approval rows first, preserving recency, and labels Telegram', async () => {
  stub(() => Response.json({ tasks: [{ ...row, id: `cos-${'0'.repeat(31)}2`, request: 'Newest done', needsYou: false, delivery: 'sent' }, row, { ...row, id: `cos-${'0'.repeat(31)}3`, request: 'Older approval' }] }));
  render(<CosTaskList />);
  await screen.findByRole('heading', { name: 'Tasks · 2 need you' });
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
    'Reply to TelegramTelegramNeeds your approval', 'Older approvalTelegramNeeds your approval', 'Newest doneTelegramSent',
  ]);
});
it('opens the existing card for the clicked id and closes it on another click', async () => {
  const fetcher = stub(url => url.includes('/cos/list') ? Response.json({ tasks: [row] })
    : Response.json({ ...row, draft: { text: 'A real draft', digest: 'fake-digest' }, v: 1 }));
  render(<CosTaskList />);
  const button = await screen.findByRole('button', { name: /Reply to Telegram/ });
  fireEvent.click(button);
  await screen.findByText('A real draft');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(`/cos/status?id=${ID}`))).toBe(true);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(button);
  expect(screen.queryByRole('region', { name: 'Task' })).toBeNull();
  expect(button).toHaveAttribute('aria-expanded', 'false');
});
it('renders nothing for an empty list', async () => {
  stub(() => Response.json({ tasks: [] }));
  const { container } = render(<CosTaskList />);
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});
it('shows a muted error line on a 500', async () => {
  stub(() => Response.json({}, { status: 500 }));
  render(<CosTaskList />);
  await screen.findByText('Tasks are unavailable right now');
});
it('polls at 30 seconds only while visible', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetcher = stub(() => Response.json({ tasks: [{ ...row, request: '' }] }));
  const { rerender } = render(<SectionVisibilityProvider visible><CosTaskList /></SectionVisibilityProvider>);
  await screen.findByText('(no preview)');
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rerender(<SectionVisibilityProvider visible={false}><CosTaskList /></SectionVisibilityProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
