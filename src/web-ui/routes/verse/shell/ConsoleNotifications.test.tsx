import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveFleetMergeNotifications } from '../../../components/notifications/deriveFleetMergeNotifications.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot, reconcileNotifications } from '../../../components/notifications/notification-store.js';
import { ConsoleBell, ConsoleNotificationCenter } from './ConsoleNotifications.js';

// Keep query polling out of these shell adapter tests; the real center and store run.
vi.mock('../../../components/notifications/useNotificationEngine.js', () => ({ useNotificationEngine: vi.fn() }));

beforeEach(() => __resetNotificationStoreForTests());
afterEach(() => { cleanup(); __resetNotificationStoreForTests(); });

describe('console notifications', () => {
  it('renders the accessible bell and toggles the shared panel state', () => {
    render(<ConsoleBell expanded={false} compact={false} />);
    const bell = screen.getByRole('button', { name: 'Notifications, none open' });
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    fireEvent.click(bell);
    expect(getNotificationSnapshot().panelOpen).toBe(true);
    fireEvent.click(bell);
    expect(getNotificationSnapshot().panelOpen).toBe(false);
  });

  it.each([{ expanded: true, compact: false }, { expanded: false, compact: true }])('labels the rail when %j', (props) => {
    render(<ConsoleBell {...props} />);
    fireEvent.click(screen.getByText('Notifications'));
    expect(getNotificationSnapshot().panelOpen).toBe(true);
  });

  it('opens the real Dialog with a derived fleet merge and its count, then closes', () => {
    render(<><ConsoleBell expanded={true} compact={false} /><ConsoleNotificationCenter /></>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => reconcileNotifications(deriveFleetMergeNotifications({
      generatedAt: '2026-10-31T12:00:00.000Z', sources: { merges: 'healthy' },
      mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Add console notifications' }] },
    }, Date.parse('2026-10-31T12:00:00.000Z'))));
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 open, 0 urgent' }));
    expect(screen.getByRole('dialog', { name: /Notifications/ })).toBeInTheDocument();
    expect(screen.getByText('Merged #42')).toBeInTheDocument();
    expect(screen.getByText('phantom: Add console notifications')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close notifications' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
