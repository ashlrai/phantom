import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { CosTaskCard } from './CosTaskCard.js';

const ID = 'cos-0123456789abcdef0123456789abcdef';
const DIGEST = 'sha256:0123456789abcdef01234567';
const base = { v: 1, id: ID, jobStatus: 'running', channel: 'email', draft: null, delivery: null, needsYou: false };
const drafted = { ...base, draft: { text: 'Reply text', digest: DIGEST }, needsYou: true };
type Handler = (url: string, init?: RequestInit) => Response;
function stub(handler: Handler) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const posts = (f: ReturnType<typeof stub>) => f.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('shows no reconcile buttons unless the delivery is uncertain', async () => {
  stub(() => Response.json(drafted));
  render(<CosTaskCard id={ID} />);
  await screen.findByRole('button', { name: 'Approve' });
  expect(screen.queryByRole('button', { name: 'It arrived' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
});

it('offers both choices for an uncertain delivery and It arrived posts delivered', async () => {
  const fetcher = stub((_url, init) => init?.method === 'POST'
    ? Response.json({ v: 1, id: ID, delivery: 'sent' }) : Response.json({ ...drafted, delivery: 'uncertain' }));
  render(<CosTaskCard id={ID} />);
  await screen.findByText('The send may not have arrived. Check email, then:');
  fireEvent.click(screen.getByRole('button', { name: 'It arrived' }));
  await screen.findByText('Sent');
  expect(posts(fetcher)).toHaveLength(1);
  expect(String(posts(fetcher)[0]![0])).toBe('/api/verse/fleet/cos/reconcile');
  expect(JSON.parse(String(posts(fetcher)[0]![1]!.body))).toEqual({ id: ID, verdict: 'delivered' });
  expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
});

it('Send again posts retry, refetches and shows Approve', async () => {
  let cleared = false;
  const fetcher = stub((_url, init) => {
    if (init?.method === 'POST') { cleared = true; return Response.json({ v: 1, id: ID, delivery: null }); }
    return Response.json({ ...drafted, delivery: cleared ? null : 'uncertain' });
  });
  render(<CosTaskCard id={ID} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Send again' }));
  await screen.findByRole('button', { name: 'Approve' });
  expect(JSON.parse(String(posts(fetcher)[0]![1]!.body))).toEqual({ id: ID, verdict: 'retry' });
  expect(screen.queryByRole('button', { name: 'It arrived' })).toBeNull();
});

it('disables both buttons while busy and maps COS_STILL_SENDING to a note', async () => {
  let release: (r: Response) => void = () => {};
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { release = resolve; })
    : Response.json({ ...drafted, delivery: 'uncertain' }));
  vi.stubGlobal('fetch', fetcher);
  render(<CosTaskCard id={ID} />);
  fireEvent.click(await screen.findByRole('button', { name: 'It arrived' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'It arrived' })).toBeDisabled());
  expect(screen.getByRole('button', { name: 'Send again' })).toBeDisabled();
  release(Response.json({ code: 'COS_STILL_SENDING' }, { status: 409 }));
  await screen.findByText('Still sending; try again in a few minutes');
  expect(screen.getByRole('button', { name: 'It arrived' })).not.toBeDisabled();
});
