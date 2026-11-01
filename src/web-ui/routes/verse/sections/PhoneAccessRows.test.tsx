import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { PhoneAccessRows } from './PhoneAccessRows.js';

vi.mock('../../../components/primitives/clipboard.js', () => ({ copyText: vi.fn(async () => true) }));
const snapshot = { v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running',
  phoneUrl: 'https://phone.example.invalid/verse/m', publicOrigin: 'https://phone.example.invalid',
  pending: 1, devices: { active: 1, revoked: 0 } };
beforeEach(() => { evictAll(); vi.mocked(copyText).mockReset().mockResolvedValue(true); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(data: unknown = snapshot, status = 200) {
  const fetch = vi.fn(async () => Response.json(data, { status }));
  vi.stubGlobal('fetch', fetch);
  render(<ToastProvider><PhoneAccessRows /></ToastProvider>);
  return fetch;
}
it('renders the URL and counts and copies both actions', async () => {
  mount();
  const link = await screen.findByRole('link', { name: snapshot.phoneUrl });
  expect(link).toHaveAttribute('href', snapshot.phoneUrl);
  expect(link).toHaveAttribute('target', '_blank');
  expect(screen.getByText('Gateway running · 1 phone paired · 1 pairing waits for you')).toBeInTheDocument();
  expect(screen.getByText('1 pairing waits for you below')).toBeInTheDocument();
  expect(screen.getByText('running')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy phone URL' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(snapshot.phoneUrl));
  expect(await screen.findByText('Phone URL copied.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy invite command' }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith('ashlr verse remote invite <Access-subject> act'));
}, 15_000);
it('hides the panel when the route is not in this build', async () => {
  const fetch = mount({}, 404);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Phone')).not.toBeInTheDocument());
}, 15_000);
it('reports errors and clipboard failure', async () => {
  vi.mocked(copyText).mockResolvedValue(false);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Copy phone URL' }));
  expect(await screen.findByText('Could not reach the clipboard.')).toBeInTheDocument();
}, 15_000);
it('hides the panel when the card fails to render', async () => {
  const model = await import('./phone-access-model.js');
  vi.spyOn(model, 'phoneAccessTell').mockImplementation(() => { throw new Error('boom'); });
  mount();
  await waitFor(() => expect(screen.queryByText('Loading phone access…')).not.toBeInTheDocument());
  expect(screen.queryByText('Phone')).not.toBeInTheDocument();
}, 15_000);
it('does not show unsafe URLs from malformed responses', async () => {
  mount({ ...snapshot, phoneUrl: `${snapshot.phoneUrl}?v=1` });
  expect(await screen.findByText('Phone access unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
}, 15_000);
it('polls every 30 seconds only while visible', async () => {
  const fetch = vi.fn(async () => Response.json(snapshot));
  vi.stubGlobal('fetch', fetch);
  const view = (visible: boolean) => <ToastProvider><SectionVisibilityProvider visible={visible}><PhoneAccessRows /></SectionVisibilityProvider></ToastProvider>;
  vi.useFakeTimers();
  try {
    const { rerender } = render(view(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('1 pairing waits for you below')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    rerender(view(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
}, 15_000);
