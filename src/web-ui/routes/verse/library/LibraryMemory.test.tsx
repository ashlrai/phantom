import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CosMemorySection, LIBRARY_MEMORY_POLL_MS } from './CosMemorySection.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const entry = (id: string, text: string, updated: string) => ({ id, kind: 'fact', source: 'desktop', updated, text });

beforeEach(() => evictAll());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

describe('Leader memory in the Library', () => {
  it('lists newer entries first with source and expands a clipped body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ v: 1, entries: [
      entry('old', 'fake older note', '2026-01-01T00:00:00Z'),
      entry('new', 'fake newer note', '2026-01-03T00:00:00Z'),
    ] })));
    render(<CosMemorySection visible />);
    const list = await screen.findByRole('list', { name: 'Remembered about you' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('fake newer note');
    expect(rows[1]).toHaveTextContent('fake older note');
    expect(rows[0]).toHaveTextContent('desktop');
    const toggle = within(rows[0]!).getByRole('button', { name: 'fake newer note' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ v: 1, entries: [] })));
    render(<CosMemorySection visible />);
    expect(await screen.findByText(/Nothing remembered yet/)).toBeInTheDocument();
  });

  it('keeps the last good list and shows the status when a refresh fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    vi.stubGlobal('fetch', vi.fn(async () => fail ? json({ code: 'MEMORY_UNAVAILABLE' }, 503) : json({ v: 1, entries: [entry('a', 'fake kept note', '2026-01-01T00:00:00Z')] })));
    render(<CosMemorySection visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('fake kept note')).toBeInTheDocument();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_MEMORY_POLL_MS); });
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 503');
    expect(screen.getByText('fake kept note')).toBeInTheDocument();
  });
});
