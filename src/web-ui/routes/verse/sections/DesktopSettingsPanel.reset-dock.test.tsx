import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { DesktopSettingsPanel } from './DesktopSettingsPanel.js';

vi.mock('../../../app/desktop-state.js', () => ({
  useDesktopState: () => ({ hotkey: { enabled: false, registered: false, accelerator: 'shortcut', error: null }, notifications: { enabled: false, delivery: 'native' } }),
  setDesktopPreference: vi.fn(),
}));
vi.mock('./UpdateStatusRow.js', () => ({ UpdateStatusRow: () => null }));
vi.mock('./dock-reset.js', () => ({ resetDockLayout: vi.fn() }));

it('resets the dock and confirms the action', async () => {
  const { resetDockLayout } = await import('./dock-reset.js');
  render(<ToastProvider><DesktopSettingsPanel /></ToastProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(resetDockLayout).toHaveBeenCalledOnce();
  expect(screen.getByText('Dock layout reset')).toBeInTheDocument();
});
