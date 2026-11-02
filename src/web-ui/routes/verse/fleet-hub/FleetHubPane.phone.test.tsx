import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { pairedDevicesQuery } from '../sections/paired-devices-query.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { getVerseUiState, resetVerseUi, VERSE_ANCHOR_EVENT } from '../verse-ui-store.js';
import { FleetHubPane } from './FleetHubPane.js';

const device = { id: 'dev-fake-1', label: 'Fake phone', email: 'fake@example.com', subject: 'fake-subject', act: false,
  createdAt: '2026-01-01T00:00:00Z', lastUsedAt: new Date().toISOString(), revokedAt: null };
const devices = { v: 1, generatedAt: new Date().toISOString(), sourceState: 'healthy', devices: [device] };
const pending = { v: 1, generatedAt: new Date().toISOString(), gateway: 'running', approvals: [] };
const response = (data: unknown, status = 200) => Promise.resolve(Response.json(data, { status }));

beforeEach(() => {
  evictAll(); resetVerseUi();
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (String(path).endsWith('/remote-devices')) return response(devices);
    if (String(path).endsWith('/remote-pending')) return response(pending);
    return response({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the paired reading after Bus and opens the Settings Connection anchor', async () => {
  const anchors = vi.fn();
  window.addEventListener(VERSE_ANCHOR_EVENT, anchors);
  try {
    render(<FleetHubPane visible />);
    const tile = (await screen.findByText('1 paired · last read 0 m ago')).closest('button')!;
    expect(tile).toHaveAttribute('data-tone', 'ok');
    expect(tile.previousElementSibling).toHaveTextContent('Bus');
    fireEvent.click(tile);
    expect(getVerseUiState().section).toBe('settings');
    expect(anchors.mock.calls[0]?.[0].detail).toEqual({ section: 'settings', anchor: 'fleet-sources' });
  } finally { window.removeEventListener(VERSE_ANCHOR_EVENT, anchors); }
});
it('shows pending approvals ahead of paired devices', async () => {
  vi.mocked(fetch).mockImplementation((path) => String(path).endsWith('/remote-devices') ? response(devices)
    : String(path).endsWith('/remote-pending') ? response({ ...pending, approvals: [{ id: '12345678-abcd-1234-abcd-123456789abc', label: 'Fake', email: 'fake@example.com', subject: 'fake' }] }) : response({}, 404));
  render(<FleetHubPane visible />);
  const tile = (await screen.findByText('1 waiting for approval')).closest('button');
  expect(tile).toHaveTextContent('Phone: approve');
  expect(tile).toHaveAttribute('data-tone', 'danger');
});
it('shows a warning when either query fails, including after a successful read', async () => {
  render(<FleetHubPane visible />);
  await screen.findByText('1 paired · last read 0 m ago');
  await act(async () => { await refetchQuery(pairedDevicesQuery.key, async () => { throw new Error('fake failure'); }, true); });
  expect(screen.getByText('Phone status unavailable').closest('button')).toHaveAttribute('data-tone', 'warn');
});
it('polls both phone queries while visible and stops when hidden', async () => {
  vi.useFakeTimers();
  const view = render(<SectionVisibilityProvider visible><FleetHubPane visible /></SectionVisibilityProvider>);
  await act(async () => {});
  const calls = () => vi.mocked(fetch).mock.calls.filter(([path]) => /remote-(devices|pending)$/.test(String(path)));
  expect(calls()).toHaveLength(2);
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(calls()).toHaveLength(4);
  view.rerender(<SectionVisibilityProvider visible={false}><FleetHubPane visible /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(calls()).toHaveLength(4);
});
it('does not show a partial reading while the pending query is loading', async () => {
  vi.mocked(fetch).mockImplementation((path) => String(path).endsWith('/remote-devices') ? response(devices)
    : String(path).endsWith('/remote-pending') ? new Promise(() => {}) : response({}, 404));
  render(<FleetHubPane visible />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/remote-pending'))).toBe(true));
  expect(screen.queryByText(/paired · last read/)).not.toBeInTheDocument();
});
