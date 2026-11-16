import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('../../../app/desktop-updates.js', () => ({ useDesktopUpdates: () => mocks.state, refreshDesktopUpdates: vi.fn(() => true) }));
vi.mock('../../../app/desktop-state.js', () => ({ setDesktopPreference: vi.fn(() => true) }));
import { UpdateStatus } from './UpdateStatus.js';
const idle = { phase: 'idle', enabled: true, version: '3.29.15', bytesReceived: 0, bytesTotal: null, reason: null };
beforeEach(() => { mocks.state = { ...idle }; });
describe('Phantom update status version', () => {
  it('idle names the installed version and the no-newer-release line', () => {
    render(<UpdateStatus />);
    expect(screen.getAllByText('Checking the update feed…').length).toBeGreaterThan(0);
    expect(screen.queryByText('No update found')).toBeNull();
    expect(screen.getByLabelText('Desktop updates: Checking the update feed…')).toBeTruthy();
  });
  it('available shows the target version', () => {
    mocks.state = { ...idle, phase: 'available', version: '3.30.1' }; render(<UpdateStatus />);
    expect(screen.getAllByText('Update available · v3.30.1').length).toBeGreaterThan(0);
  });
  it('a state without a version still has a badge', () => {
    mocks.state = { ...idle, version: null }; render(<UpdateStatus />);
    expect(screen.getAllByText('Checking the update feed…').length).toBeGreaterThan(0);
  });
});
