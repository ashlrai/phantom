import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { CosTaskCard, COS_LAST_KEY } from './CosTaskCard.js';

const ID = 'cos-0123456789abcdef0123456789abcdef';
const DIGEST = 'sha256:0123456789abcdef01234567';
const base = { v: 1, id: ID, jobStatus: 'running', channel: 'email', draft: null, delivery: null, needsYou: false };
const drafted = { ...base, draft: { text: 'Line one\nLine two', digest: DIGEST }, needsYou: true };
type Handler = (url: string, init?: RequestInit) => Response;
function stub(handler: Handler) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const posts = (f: ReturnType<typeof stub>) => f.mock.calls.filter(([, init]) => init?.method === 'POST');
const gets = (f: ReturnType<typeof stub>) => f.mock.calls.filter(([, init]) => init?.method === 'GET');

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.useRealTimers(); clearMutationToken(); vi.unstubAllGlobals(); });

it('shows the queued line and no button without a draft', async () => {
  stub(() => Response.json({ ...base, jobStatus: 'queued' }));
  render(<CosTaskCard id={ID} />);
  await screen.findByText(/^Queued/);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('shows the full draft and posts the digest once on Approve', async () => {
  const fetcher = stub((_url, init) => init?.method === 'POST' ? Response.json({ v: 1, id: ID, delivery: 'sent' }) : Response.json(drafted));
  render(<CosTaskCard id={ID} />);
  const pre = await screen.findByText((_c, el) => el?.tagName === 'PRE' && el.textContent === 'Line one\nLine two');
  expect(pre).toBeTruthy();
  screen.getByText(/email/);
  const button = screen.getByRole('button', { name: 'Approve' });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText('Sent');
  expect(posts(fetcher)).toHaveLength(1);
  expect(JSON.parse(String(posts(fetcher)[0]![1]!.body))).toEqual({ id: ID, digest: DIGEST });
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('says the draft changed on a stale approval and refetches', async () => {
  const fetcher = stub((_url, init) => init?.method === 'POST'
    ? Response.json({ code: 'COS_APPROVAL_STALE' }, { status: 409 }) : Response.json(drafted));
  render(<CosTaskCard id={ID} />);
  await screen.findByRole('button', { name: 'Approve' });
  const before = gets(fetcher).length;
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('Draft changed; review the new text');
  await waitFor(() => expect(gets(fetcher).length).toBe(before + 1));
});

it('shows the uncertain line on a 502', async () => {
  stub((_url, init) => init?.method === 'POST'
    ? Response.json({ code: 'COS_DELIVERY_UNCERTAIN' }, { status: 502 }) : Response.json(drafted));
  render(<CosTaskCard id={ID} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  await screen.findByText('Delivery uncertain; check the channel before any retry');
});

it('polls every 15s and stops after sent', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let n = 0;
  const fetcher = stub(() => Response.json(++n < 3 ? base : { ...base, delivery: 'sent' }));
  render(<CosTaskCard id={ID} />);
  await screen.findByText('A worker is on it');
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await screen.findByText('Sent');
  const count = gets(fetcher).length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(gets(fetcher).length).toBe(count);
});

it('resumes from localStorage after remount', async () => {
  stub(() => Response.json(base));
  const first = render(<CosTaskCard id={ID} />);
  await screen.findByText('A worker is on it');
  expect(localStorage.getItem(COS_LAST_KEY)).toBe(ID);
  first.unmount();
  const { InterjectBox } = await import('./InterjectBox.js');
  render(<InterjectBox />);
  await waitFor(() => expect(screen.getAllByText('A worker is on it').length).toBe(1));
});

function boxStub(askStatus = 201) {
  return stub((url, init) => {
    if (url.endsWith('/cos/ask')) return askStatus === 201
      ? Response.json({ v: 1, id: ID, ack: 'Queued for the chief of staff.', status: 'queued', duplicate: false }, { status: 201 })
      : Response.json({ error: 'nope' }, { status: askStatus });
    if (url.includes('/cos/status')) return Response.json({ ...base, jobStatus: 'queued' });
    if (init?.method === 'POST') return Response.json({ at: '2026-10-31T12:00:00Z' }, { status: 201 });
    return Response.json({ inbox: [] });
  });
}

it('InterjectBox: ticked, submit asks and renders the card, not the inbox post', async () => {
  const fetcher = boxStub();
  const { InterjectBox } = await import('./InterjectBox.js');
  render(<InterjectBox />);
  fireEvent.click(screen.getByLabelText('Run as task'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reply to Sam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Queued for the chief of staff.');
  await screen.findByText(/^Queued · /);
  const urls = posts(fetcher).map(([url]) => String(url));
  expect(urls).toEqual(['/api/verse/fleet/cos/ask']);
  expect(JSON.parse(String(posts(fetcher)[0]![1]!.body))).toEqual({ text: 'Reply to Sam' });
  expect(screen.getByRole('textbox')).toHaveValue('');
});

it('InterjectBox: unticked, submit posts to the inbox as before', async () => {
  const fetcher = boxStub();
  const { InterjectBox } = await import('./InterjectBox.js');
  render(<InterjectBox />);
  expect(screen.getByLabelText('Run as task')).not.toBeChecked();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Plain note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/^Sent ·/);
  expect(posts(fetcher).map(([url]) => String(url))).toEqual(['/api/verse/fleet/runs/inbox']);
});

it('InterjectBox: an absent task route keeps the draft', async () => {
  boxStub(404);
  const { InterjectBox } = await import('./InterjectBox.js');
  render(<InterjectBox />);
  fireEvent.click(screen.getByLabelText('Run as task'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Tasks are not in this build yet');
  expect(screen.getByRole('textbox')).toHaveValue('Keep me');
});
