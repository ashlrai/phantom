import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { CosMemorySection } from './CosMemorySection.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const E = (id: string, kind: string, text: string, msAgo = 3 * 3_600_000) => ({ id, kind, source: 'desktop', updated: iso(msAgo), text });

interface Call { method: string; url: string; body: unknown }
let calls: Call[];
let entries: unknown[];
let getStatus: number;
let postAnswer: (url: string) => Response;

beforeEach(() => {
  evictAll();
  setMutationToken('a'.repeat(64));
  calls = [];
  entries = [];
  getStatus = 200;
  postAnswer = () => json({ v: 1, removed: true });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return getStatus === 200 ? json({ v: 1, entries }) : json({ code: 'MEMORY_UNAVAILABLE' }, getStatus);
    return postAnswer(url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); clearMutationToken(); });

const posts = () => calls.filter((c) => c.method === 'POST');
const gets = () => calls.filter((c) => c.method === 'GET');

describe('CosMemorySection', () => {
  it('lists entries as plain text with kind, source and age, doctrine first', async () => {
    entries = [E('f', 'fact', 'Plain fake fact'), E('d', 'doctrine', '<b>fake rule</b>')];
    const { container } = render(<CosMemorySection visible />);
    const list = await screen.findByRole('list', { name: 'Remembered about you' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('doctrine');
    expect(rows[0]).toHaveTextContent('<b>fake rule</b>');
    expect(rows[0]).toHaveTextContent('3 h ago');
    expect(rows[1]).toHaveTextContent('Plain fake fact');
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows the empty state', async () => {
    render(<CosMemorySection visible />);
    expect(await screen.findByText('Nothing remembered yet. Tell the Leader a preference, or add one here.')).toBeInTheDocument();
  });

  it('shows a danger note and no list when memory is unavailable', async () => {
    getStatus = 503;
    render(<CosMemorySection visible />);
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('Forget confirms inline, posts {id}, then refetches', async () => {
    entries = [E('abc', 'fact', 'Fake fact to drop')];
    render(<CosMemorySection visible />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    expect(posts()).toHaveLength(0);
    const before = gets().length;
    entries = [];
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/verse/cos/memory/forget', body: { id: 'abc' } });
    await waitFor(() => expect(gets().length).toBeGreaterThan(before));
    expect(await screen.findByText('Nothing remembered yet. Tell the Leader a preference, or add one here.')).toBeInTheDocument();
  });

  it('Keep cancels the confirm without posting', async () => {
    entries = [E('abc', 'fact', 'Fake fact')];
    render(<CosMemorySection visible />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Forget' })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('Remember is disabled while empty and posts exactly {kind, text}', async () => {
    postAnswer = () => json({ v: 1, entry: E('n', 'doctrine', 'Fake rule') }, 201);
    render(<CosMemorySection visible />);
    const button = await screen.findByRole('button', { name: 'Remember' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'doctrine' } });
    fireEvent.change(screen.getByLabelText('What should Phantom remember?'), { target: { value: 'Fake rule' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: '/api/verse/cos/memory', body: { kind: 'doctrine', text: 'Fake rule' } });
    expect(await screen.findByText('Remembered.')).toBeInTheDocument();
    expect(screen.getByLabelText('What should Phantom remember?')).toHaveValue('');
  });

  it("shows the server's sentence on a 422 and keeps the text", async () => {
    postAnswer = () => json({ code: 'MEMORY_REFUSED', error: 'Fixed refusal sentence.' }, 422);
    render(<CosMemorySection visible />);
    fireEvent.change(await screen.findByLabelText('What should Phantom remember?'), { target: { value: 'Fake note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }));
    expect(await screen.findByText('Fixed refusal sentence.')).toBeInTheDocument();
    expect(screen.getByLabelText('What should Phantom remember?')).toHaveValue('Fake note');
  });

  it('asks to unlock when there is no mutation token', async () => {
    clearMutationToken();
    render(<CosMemorySection visible />);
    fireEvent.change(await screen.findByLabelText('What should Phantom remember?'), { target: { value: 'Fake note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remember' }));
    expect(await screen.findByText('Unlock to change memory.')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
