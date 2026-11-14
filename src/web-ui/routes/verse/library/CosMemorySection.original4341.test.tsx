import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CosMemorySection, LIBRARY_MEMORY_POLL_MS } from './CosMemorySection.js';

const MEMORY_PATH = '/api/verse/cos/memory';
const EMPTY_TEXT = 'Nothing remembered yet. Tell the Leader a preference, or add one here.';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const entry = (id: string, text: string, updated: string, source = 'desktop') => ({
  id, kind: 'fact', source, updated, text,
});

interface Call { method: string; url: string }
let calls: Call[];
let respond: () => Response;

const gets = () => calls.filter((call) => call.method === 'GET');
const posts = () => calls.filter((call) => call.method === 'POST');
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  vi.useFakeTimers();
  evictAll();
  calls = [];
  respond = () => json({ v: 1, entries: [] });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input) });
    return respond();
  }));
});

afterEach(() => {
  cleanup();
  evictAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CosMemorySection original #4341 read-only evidence', () => {
  it('GETs memory and renders same-kind entries newest-first with expandable plain text', async () => {
    const now = Date.now();
    const longText = `fake remembered note with literal <b>markup</b> text ${'and more detail '.repeat(12)}`.trim();
    respond = () => json({ v: 1, entries: [
      entry('older', 'fake older fact', new Date(now - 2 * 24 * 3_600_000).toISOString(), 'phone'),
      entry('newer', longText, new Date(now - 3 * 3_600_000).toISOString(), 'desktop'),
    ] });

    render(<CosMemorySection visible />);
    await flush();

    expect(gets()).toHaveLength(1);
    expect(gets()[0]).toMatchObject({ method: 'GET', url: MEMORY_PATH });
    const list = screen.getByRole('list', { name: 'Remembered about you' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('fact');
    expect(rows[0]).toHaveTextContent('desktop');
    expect(rows[0]).toHaveTextContent('3 h ago');
    expect(rows[1]).toHaveTextContent('phone');
    expect(rows[1]).toHaveTextContent('2 d ago');
    expect(rows[0]).toHaveTextContent(longText);
    expect(rows[1]).toHaveTextContent('fake older fact');

    const toggle = within(rows[0]!).getAllByRole('button')
      .find((button) => button.hasAttribute('aria-expanded'))!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.textContent).toBe(longText);
    expect(toggle.querySelector('b')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle.textContent).toBe(longText);
    expect(toggle.querySelector('b')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('renders the current empty sentence after a successful empty read', async () => {
    render(<CosMemorySection visible />);
    await flush();

    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(gets()).toHaveLength(1);
    expect(posts()).toHaveLength(0);
  });

  it('keeps the last good note through a polling 503, then replaces it on recovery', async () => {
    let stage: 'kept' | 'failed' | 'replaced' = 'kept';
    respond = () => {
      if (stage === 'failed') return json({ code: 'MEMORY_UNAVAILABLE' }, 503);
      if (stage === 'replaced') {
        return json({ v: 1, entries: [entry('refreshed', 'fake refreshed note', '2026-01-04T00:00:00Z')] });
      }
      return json({ v: 1, entries: [entry('kept', 'fake kept note', '2026-01-01T00:00:00Z')] });
    };

    render(<CosMemorySection visible />);
    await flush();
    expect(screen.getByText('fake kept note')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    stage = 'failed';
    await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_MEMORY_POLL_MS); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh memory (HTTP 503).');
    expect(screen.getByText('fake kept note')).toBeInTheDocument();

    stage = 'replaced';
    await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_MEMORY_POLL_MS); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('fake kept note')).toBeNull();
    expect(screen.getByText('fake refreshed note')).toBeInTheDocument();
    expect(gets()).toHaveLength(3);
    expect(posts()).toHaveLength(0);
  });
});
