import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => ({ phase: 'idle', enabled: true, version: '1.0.0', bytesReceived: 0, bytesTotal: null, reason: null }), refreshDesktopUpdates: vi.fn() }));
vi.mock('../../../app/desktop-state.js', () => ({ setDesktopPreference: vi.fn() }));
vi.mock('../../../data/client.js', () => ({ apiGet: (path: string) => Promise.resolve(path.endsWith('/why') ? { message: 'The latest release has no assets.' } : null) }));
import { UpdateStatus } from './UpdateStatus.js';
it('shows the diagnostic sentence in the header', async () => {
  render(<UpdateStatus />);
  expect(await screen.findByLabelText('Desktop updates: The latest release has no assets.')).toBeTruthy();
});
