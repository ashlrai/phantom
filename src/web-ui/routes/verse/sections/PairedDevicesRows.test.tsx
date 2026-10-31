import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { PairedDevicesRows } from './PairedDevicesRows.js';
const id = '11111111-1111-1111-1111-111111111111';
const device = { id, label: 'Fake phone', email: 'fake@example.invalid', subject: 'fake', act: true, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null };
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(devices: unknown[] = [], status = 200) {
  const fetch = vi.fn(async () => Response.json({ v: 1, generatedAt: device.createdAt, sourceState: 'healthy', devices }, { status }));
  vi.stubGlobal('fetch', fetch);
  render(<ToastProvider><PairedDevicesRows /></ToastProvider>);
  return fetch;
}
it('renders both devices, scopes, dates and the exact copyable command', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  mount([device, { ...device, id: '22222222-2222-2222-2222-222222222222', label: 'Fake tablet', act: false, revokedAt: device.createdAt }]);
  expect(await screen.findByText('Fake phone · fake@example.invalid')).toBeInTheDocument();
  expect(screen.getByText('Fake tablet · fake@example.invalid')).toBeInTheDocument();
  expect(screen.getByText('revoked')).toBeInTheDocument();
  expect(screen.getByText('active')).toBeInTheDocument();
  expect(screen.getByText('read + act')).toBeInTheDocument();
  expect(screen.getByText('read')).toBeInTheDocument();
  expect(screen.getAllByText(/Created 2026-01-01.*never/)).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', { name: 'Copy revoke command' })[0]);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`phm verse remote revoke ${id}`));
  expect(await screen.findByText('Revoke command copied.')).toBeInTheDocument();
});
it('shows pairing instructions for an empty registry', async () => {
  mount();
  expect(await screen.findByText(/No phones are paired/)).toBeInTheDocument();
  expect(screen.getByText('phm verse remote invite <Access-subject>')).toBeInTheDocument();
});
it('hides the panel when the route is not in this build', async () => {
  const fetch = mount([], 404);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Paired devices')).not.toBeInTheDocument());
});
it('shows a bounded failure and no pairing instructions for a failed read', async () => {
  mount([], 500);
  expect(await screen.findByText('Paired devices unavailable.')).toBeInTheDocument();
  expect(screen.queryByText(/No phones are paired/)).not.toBeInTheDocument();
});
it('does not offer an unsafe revoke command', async () => {
  mount([{ ...device, id: 'invalid; fake' }]);
  await screen.findByText('Fake phone · fake@example.invalid');
  expect(screen.queryByRole('button', { name: 'Copy revoke command' })).not.toBeInTheDocument();
});

it('polls every minute only while visible', async () => {
  const fetch = vi.fn(async () => Response.json({ v: 1, devices: [] }));
  vi.stubGlobal('fetch', fetch);
  const view = (visible: boolean) => <ToastProvider><SectionVisibilityProvider visible={visible}><PairedDevicesRows /></SectionVisibilityProvider></ToastProvider>;
  vi.useFakeTimers();
  try {
    const { rerender } = render(view(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/No phones are paired/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(2);
    rerender(view(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
