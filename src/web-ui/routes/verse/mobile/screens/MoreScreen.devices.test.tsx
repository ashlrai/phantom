import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../../../data/client.js';
import { evictAll } from '../../../../data/cache.js';
import { SectionVisibilityProvider } from '../../shell/section-visibility.js';
import { permissionsFor, renderMobile } from '../mobile.test-support.js';
import { deviceRows, narrowPairedDevices, pairedDevicesQuery } from '../paired-devices-query.js';
import { MoreScreen } from './MoreScreen.js';

const PATH = '/api/verse/fleet/control/remote-devices';
const now = '2026-10-31T12:00:00.000Z';
const fixture = () => ({
  v: 1, generatedAt: now, sourceState: 'healthy', extra: 'ignored',
  devices: [
    { id: '2', label: 'Old tablet', email: 'tablet@example.test', subject: 'private-subject-two', act: false,
      createdAt: now, lastUsedAt: '2026-10-31T11:59:00.000Z', revokedAt: '2026-10-30T12:00:00.000Z' },
    { id: '1', label: 'My phone', email: 'mason@example.test', subject: 'private-subject-one', act: true,
      createdAt: now, lastUsedAt: '2026-10-31T11:57:00.000Z', revokedAt: null },
  ],
});

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now)); });
afterEach(() => {
  evictAll();
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

function mount() {
  return renderMobile(<MoreScreen />, { permissions: { ...permissionsFor('unlocked'), source: 'device', deviceLabel: 'My phone' } });
}

function devicesSection() {
  return screen.getByRole('region', { name: 'Devices paired to this Mac' });
}

describe('paired devices on More', () => {
  it('shows active devices first, marks this phone, and hides subjects and email local parts', async () => {
    const api = vi.spyOn(client, 'apiGet').mockResolvedValue(fixture());
    mount();
    const section = devicesSection();
    await within(section).findByText('Old tablet');
    expect(api).toHaveBeenCalledWith(PATH, undefined);
    expect(section.textContent).toMatch(/My phone[\s\S]*Old tablet/);
    expect(within(section).getByText('This phone')).toBeInTheDocument();
    expect(section).toHaveTextContent('…n@example.test');
    expect(section).toHaveTextContent('…t@example.test');
    expect(within(section).getByText(/Act · last used 3 m ago/)).toBeInTheDocument();
    expect(within(section).getByText(/Read only · last used 1 m ago · Revoked/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/private-subject|mason@example|tablet@example/);
  }, 15_000);

  it('explains remote access without fetching devices', async () => {
    document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
    const api = vi.spyOn(client, 'apiGet');
    mount();
    expect(within(devicesSection()).getByText("Paired devices are listed when you open this on the Mac's network.")).toBeInTheDocument();
    await waitFor(() => expect(api).not.toHaveBeenCalled());
  });

  it('shows not in this build on 404', async () => {
    vi.spyOn(client, 'apiGet').mockRejectedValue(new client.ApiError('not found', 404, PATH));
    mount();
    expect(await within(devicesSection()).findByText('Not in this build yet')).toBeInTheDocument();
  });

  it('shows an empty state and retries failed reads', async () => {
    const api = vi.spyOn(client, 'apiGet').mockRejectedValueOnce(new Error('private-subject'))
      .mockResolvedValueOnce({ ...fixture(), sourceState: 'missing', devices: [] });
    mount();
    const section = devicesSection();
    expect(await within(section).findByRole('alert')).toHaveTextContent('Couldn’t load paired devices');
    expect(section).not.toHaveTextContent('private-subject');
    fireEvent.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByText('No devices paired yet')).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('polls only while visible', async () => {
    const api = vi.spyOn(client, 'apiGet').mockResolvedValue(fixture());
    vi.useFakeTimers();
    try {
      const result = renderMobile(<SectionVisibilityProvider visible><MoreScreen /></SectionVisibilityProvider>);
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(api).toHaveBeenCalledTimes(2);
      result.rerender(<SectionVisibilityProvider visible={false}><MoreScreen /></SectionVisibilityProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(api).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('validates the complete shape and ISO dates while discarding unknown fields', async () => {
    const raw = fixture();
    const data = narrowPairedDevices(raw);
    expect(data).not.toBeNull();
    expect(JSON.stringify(data)).not.toMatch(/private-subject|ignored/);
    expect(narrowPairedDevices({ ...raw, generatedAt: 'October 31, 2026' })).toBeNull();
    expect(narrowPairedDevices({ ...raw, devices: [{ ...raw.devices[0], createdAt: '2026-02-30T12:00:00Z' }] })).toBeNull();
    expect(narrowPairedDevices({ ...raw, devices: [{ ...raw.devices[0], lastUsedAt: '2026-10-31' }] })).toBeNull();
    expect(narrowPairedDevices({ ...raw, devices: [{ ...raw.devices[0], act: 'yes' }] })).toBeNull();
    vi.spyOn(client, 'apiGet').mockResolvedValue({ ...raw, generatedAt: 'bad' });
    await expect(pairedDevicesQuery.fetch()).rejects.toMatchObject({ status: 502 });
    const neverUsed = narrowPairedDevices({ ...raw, devices: [{ ...raw.devices[1], act: false, lastUsedAt: null }] });
    expect(deviceRows(neverUsed!, Date.parse(now), null)[0]?.text).toBe('Read only · never used');
  });
});
