import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { STORAGE_KEY } from '../dock/fleet-workspace-auto.js';
import { DesktopSettingsPanel } from './DesktopSettingsPanel.js';

vi.mock('../../../app/desktop-state.js', () => ({
  useDesktopState: () => ({ hotkey: { enabled: false, registered: false, accelerator: 'shortcut', error: null }, notifications: { enabled: false, delivery: 'native' } }),
  setDesktopPreference: vi.fn(),
}));
vi.mock('./UpdateStatusRow.js', () => ({ UpdateStatusRow: () => null }));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

it('turns fleet workspace auto-opening off and on', () => {
  render(<ToastProvider><DesktopSettingsPanel /></ToastProvider>);
  const toggle = screen.getByRole('switch', { name: 'Open the fleet workspace automatically when the fleet is running' });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(toggle);
  expect(localStorage.getItem(STORAGE_KEY)).toBe('off');
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(toggle);
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(toggle).toHaveAttribute('aria-checked', 'true');
});
