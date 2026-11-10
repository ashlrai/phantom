import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ state: null as unknown, get: vi.fn() }));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => mocks.state, refreshDesktopUpdates: () => true }));
vi.mock('../../../app/desktop-state.js', () => ({ setDesktopPreference: () => true }));
vi.mock('../../../data/client.js', () => ({ apiGet: mocks.get }));
import { ReleaseStages } from './ReleaseStages.js';
import { UpdateStatus } from './UpdateStatus.js';

const response = { schema: 'verse.release-stages.v1', repo: 'ashlrai/phantom', tag: 'v3.30.8', checkedAt: '2026-11-09T12:00:00Z', stages: [
  { stage: 'published', status: 'unknown', version: null, reason: 'desktop asset evidence incomplete; retry; missing or invalid: latest.json, manifest.json' },
  { stage: 'feed-ready', status: 'unknown', version: null, reason: 'feed unavailable or unsupported' }] };
beforeEach(() => {
  mocks.get.mockReset(); mocks.get.mockResolvedValue(response);
  mocks.state = { phase: 'idle', enabled: true, version: '3.29.15', bytesReceived: 0, bytesTotal: null, reason: null };
});

describe('ReleaseStages', () => {
  it('renders the rows from the fetched response', async () => {
    render(<ReleaseStages installedVersion="3.29.15" />);
    expect(await screen.findByText(/v3.30.8 published/u)).toBeTruthy();
    expect(screen.getAllByRole('listitem', { hidden: true })).toHaveLength(3);
    expect(screen.getByText(/Missing: latest.json, manifest.json/u)).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith('/api/verse/release/stages', expect.anything());
  });
  it('shows a plain error line when the read fails', async () => {
    mocks.get.mockRejectedValue(new Error('offline'));
    render(<ReleaseStages installedVersion="3.29.15" />);
    expect(await screen.findByText('The newest release could not be read.')).toBeTruthy();
  });
});

describe('UpdateStatus with release stages', () => {
  it('says the newer release is published but not installable instead of up to date', async () => {
    render(<UpdateStatus />);
    await waitFor(() => expect(screen.getByRole('status', { hidden: true }).textContent).toBe('v3.30.8 published · not installable yet'));
    expect(screen.queryByText(/Up to date/u)).toBeNull();
  });
});
