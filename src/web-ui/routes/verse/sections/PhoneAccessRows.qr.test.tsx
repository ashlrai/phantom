import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { PhoneAccessRows } from './PhoneAccessRows.js';

const snapshot = { v: 1, generatedAt: '2026-11-01T04:12:00Z', gateway: 'running',
  phoneUrl: 'https://phone.example.invalid/verse/m', publicOrigin: 'https://phone.example.invalid',
  pending: 0, devices: { active: 0, revoked: 0 } };

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  return render(<ToastProvider><PhoneAccessRows /></ToastProvider>);
}

it('shows an accessible QR code for the phone URL', async () => {
  mount(snapshot);
  const qr = await screen.findByRole('img', { name: 'Phone URL QR code' });
  expect(qr).toHaveAttribute('width', '128');
  expect(qr).toHaveAttribute('height', '128');
}, 15_000);

it('omits the QR code when there is no phone URL', async () => {
  mount({ ...snapshot, phoneUrl: null, publicOrigin: null });
  await screen.findByText('No phone gateway configured yet');
  expect(screen.queryByRole('img', { name: 'Phone URL QR code' })).not.toBeInTheDocument();
}, 15_000);

it('shows the URL text with no QR when it exceeds the encoder capacity', async () => {
  const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.invalid`;
  const publicOrigin = `https://${host}`;
  const phoneUrl = `${publicOrigin}/verse/m`;
  expect(new TextEncoder().encode(phoneUrl).length).toBeGreaterThan(213);
  mount({ ...snapshot, phoneUrl, publicOrigin });
  const link = await screen.findByRole('link', { name: phoneUrl });
  expect(link).toHaveAttribute('href', phoneUrl);
  expect(screen.getByRole('button', { name: 'Copy phone URL' })).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Phone URL QR code' })).not.toBeInTheDocument();
}, 15_000);

it('does not render a query string from an invalid phone URL', async () => {
  const query = '?v=1';
  const { container } = mount({ ...snapshot, phoneUrl: `${snapshot.phoneUrl}${query}` });
  await screen.findByText('Phone access unavailable.');
  expect(container).not.toHaveTextContent(query);
  expect(screen.queryByRole('img', { name: 'Phone URL QR code' })).not.toBeInTheDocument();
}, 15_000);
