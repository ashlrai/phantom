import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryMemory, LIBRARY_MEMORY_POLL_MS } from './LibraryMemory.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const entry = (id: string, text: string, updated: string) => ({ id, kind: 'fact', source: 'desktop', updated, text });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('LibraryMemory', () => {
  it('lists entries newest first with source, and expands a clipped body', async () => {
    const fetchMock = vi.fn(async () => json({ v: 1, entries: [
      entry('old', 'fake older note', '2026-01-01T00:00:00Z'),
      entry('new', 'fake newer note', '2026-01-03T00:00:00Z'),
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LibraryMemory />);
    expect(await screen.findByText('fake newer note')).toBeInTheDocument();
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveTextContent('fake newer note');
    expect(rows[1]).toHaveTextContent('fake older note');
    expect(rows[0]).toHaveTextContent('desktop');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/verse/cos/memory');
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(rows[0]!);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ v: 1, entries: [] })));
    render(<LibraryMemory />);
    expect(await screen.findByText('The Leader has no saved memory yet')).toBeInTheDocument();
  });

  it('keeps the last good list when a refresh fails, and shows the status', async () => {
    vi.useFakeTimers();
    let fail = false;
    vi.stubGlobal('fetch', vi.fn(async () => (fail ? json({ code: 'MEMORY_UNAVAILABLE' }, 503) : json({ v: 1, entries: [entry('a', 'fake kept note', '2026-01-01T00:00:00Z')] }))));
    render(<LibraryMemory />);
    await flush();
    expect(screen.getByText('fake kept note')).toBeInTheDocument();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_MEMORY_POLL_MS); });
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    expect(screen.getByText('fake kept note')).toBeInTheDocument();
  });
});
