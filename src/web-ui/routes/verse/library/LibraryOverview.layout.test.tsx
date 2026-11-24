import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { LibraryOverview, librarySize } from './LibraryOverview.js';
vi.mock('../../../data/auth-store.js', async original => ({ ...await original<object>(), getMutationToken: () => 'test-token', getReadClientProof: () => 'test-read-proof' }));
vi.mock('../../../data/remote-mode.js', () => ({ isRemoteMobileMode: () => false }));
const asOf = '2026-11-17T12:00:00.000Z';
const items = [
  { id: 'memory:0123456789abcdef', kind: 'memory', title: 'Use plain words', source: '~/.phantom/memory/fact-1.md', owner: 'cos', asOf, size: 2048, preview: 'Use plain words' },
  { id: 'context:0123456789abcdef', kind: 'context', title: 'review: Notes', source: 'handoff/review/NOTES.md', owner: null, asOf, size: null, preview: 'Ready for review' },
];
function Subject() {
  const [search, onSearch] = useState('');
  return <LibraryOverview visible search={search} onSearch={onSearch} />;
}
let viewport: ViewportMock | null = null;
const show = (width: number, body: unknown = { v: 1, asOf, items, unavailable: [] }) => {
  viewport = mockViewport(width);
  stubSurfaceFetch({ routes: { '/api/verse/fleet/library-files/items': body } });
  return render(<Subject />);
};
beforeEach(() => evictAll());
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); });

describe.each([['390 px', 390, 'stacked'], ['desktop width', 1440, 'split']] as const)('Library view at %s', (_name, width, layout) => {
  it('has one search box, kind chips, a list and a detail pane with owner, size and unknowns', async () => {
    show(width);
    const list = await screen.findByRole('list', { name: 'Library items' });
    expect(list.parentElement).toHaveAttribute('data-layout', layout);
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['All', 'Files', 'Media', 'Memory', 'Messages', 'Context']);
    expect(list).toHaveTextContent('cos');
    expect(list).toHaveTextContent('2.0 KB');
    fireEvent.click(within(list).getByRole('button', { name: /review: Notes/ }));
    const detail = screen.getByRole('region', { name: 'Library item' });
    expect(within(detail).getByText('Owner').nextSibling).toHaveTextContent('unknown');
    expect(within(detail).getByText('Size').nextSibling).toHaveTextContent('unknown');
    expect(detail).toHaveTextContent('phm library show context:0123456789abcdef');
  });

  it('a search miss hides the detail of an item it filters out', async () => {
    show(width);
    fireEvent.click(within(await screen.findByRole('list', { name: 'Library items' })).getByRole('button', { name: /Use plain words/ }));
    expect(screen.getByRole('region', { name: 'Library item' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no such thing' } });
    expect(screen.getByText('No Library items match.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Library item' })).toBeNull();
  });
});

it('at 390 px the detail replaces the list and Back returns to it', async () => {
  show(390);
  fireEvent.click(within(await screen.findByRole('list', { name: 'Library items' })).getByRole('button', { name: /Use plain words/ }));
  expect(screen.queryByRole('list', { name: 'Library items' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
  expect(screen.getByRole('list', { name: 'Library items' })).toBeInTheDocument();
});

it('at desktop width the list and detail sit side by side, and Close clears the pane', async () => {
  show(1440);
  const list = await screen.findByRole('list', { name: 'Library items' });
  expect(screen.getByText('Choose an item to see its details.')).toBeInTheDocument();
  fireEvent.click(within(list).getByRole('button', { name: /Use plain words/ }));
  expect(within(list).getByRole('button', { name: /Use plain words/ })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('list', { name: 'Library items' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('region', { name: 'Library item' })).toBeNull();
});

it('reads rows from an older server without owner or size as unknown, and refuses a bad size', async () => {
  show(1440, { v: 1, asOf, items: [{ id: 'file:0123456789abcdef', kind: 'file', title: 'Vision', source: 'leader/VISION.md', asOf, preview: 'Ship' }], unavailable: [] });
  expect(await screen.findByRole('list', { name: 'Library items' })).toHaveTextContent('unknown');
  cleanup(); evictAll();
  show(1440, { v: 1, asOf, items: [{ ...items[0], size: -1 }], unavailable: [] });
  expect(await screen.findByText(/Library could not refresh/)).toBeInTheDocument();
});

it('formats sizes in plain units', () => {
  expect([null, 12, 2048, 3 * 1024 * 1024].map(librarySize)).toEqual(['unknown', '12 B', '2.0 KB', '3.0 MB']);
});
