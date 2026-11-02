import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { VerseApp } from '../VerseApp.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { GearUpdateDot } from './GearUpdateDot.js';
import { useSelfUpdateBadge } from './self-update-badge.js';

vi.mock('./self-update-badge.js', () => ({ useSelfUpdateBadge: vi.fn() }));

describe('GearUpdateDot', () => {
  it('shows the update state on a rail dot', () => {
    const label = 'Phantom 3.30.0 installed · restarts when idle';
    vi.mocked(useSelfUpdateBadge).mockReturnValue({ label });
    render(<GearUpdateDot />);
    const dot = screen.getByTestId('gear-update-dot');
    expect(dot).toHaveAttribute('title', label);
    expect(dot.querySelector('[data-badge="dot"]')).toHaveAttribute('data-tone', 'info');
  });

  it('uses the warning tone for a held update', () => {
    vi.mocked(useSelfUpdateBadge).mockReturnValue({ label: 'Update held · open Settings' });
    render(<GearUpdateDot />);
    const dot = screen.getByTestId('gear-update-dot');
    expect(dot.querySelector('[data-badge="dot"]')).toHaveAttribute('data-tone', 'warning');
    expect(dot).toHaveStyle({ '--status-info-solid': 'var(--status-warning-solid)' });
  });

  it('renders nothing when no update is available', () => {
    vi.mocked(useSelfUpdateBadge).mockReturnValue(null);
    const { container } = render(<GearUpdateDot />);
    expect(container).toBeEmptyDOMElement();
  });

  it('includes the current update in the gear button name and removes it when cleared', async () => {
    const label = 'Phantom 3.30.0 installed · restarts when idle';
    vi.mocked(useSelfUpdateBadge).mockReturnValue({ label });
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', shellFetch(activity()).fetch);
    resetVerseUi();
    const app = <ToastProvider><VerseApp /></ToastProvider>;
    const view = render(app);
    try {
      const gear = screen.getByRole('button', { name: `Settings and more, update: ${label}` });
      expect(await screen.findByTestId('gear-update-dot')).toHaveAttribute('title', label);
      vi.mocked(useSelfUpdateBadge).mockReturnValue(null);
      view.rerender(<ToastProvider><VerseApp /></ToastProvider>);
      expect(gear).toHaveAccessibleName('Settings and more');
      expect(screen.queryByTestId('gear-update-dot')).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
      resetVerseUi();
    }
  });
});
