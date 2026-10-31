import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotificationCenter } from './NotificationCenter.js';
import { useNotifications } from './useNotifications.js';
import type { AppNotification, NotificationCategory, NotificationSeverity } from './types.js';

vi.mock('./useNotifications.js', () => ({ useNotifications: vi.fn() }));
vi.mock('./useNotificationEngine.js', () => ({ useNotificationEngine: vi.fn() }));

function item(id: string, category: NotificationCategory, severity: NotificationSeverity): AppNotification {
  return { id, category, severity, title: `Notice ${id}`, detail: 'Details', ts: '2026-01-01T00:00:00Z' };
}

const items = [
  item('1', 'fleet', 'critical'), item('2', 'fleet', 'high'), item('3', 'fleet', 'low'),
  item('4', 'security', 'high'), item('5', 'security', 'info'), item('6', 'security', 'info'),
  item('7', 'run', 'low'), item('8', 'run', 'info'),
];

function showItems(notifications: AppNotification[]) {
  vi.mocked(useNotifications).mockReturnValue({
    items: notifications, panelOpen: true, desktopEnabled: false, desktopPermission: 'default',
    mutedCategories: [],
  });
  render(<NotificationCenter />);
}

describe('NotificationCenter groups', () => {
  it('shows category counts and lets a group collapse and expand', () => {
    showItems(items);
    const fleet = screen.getByRole('button', { name: 'Fleet on this Mac · 3 (2 urgent)' });
    expect(fleet).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Security · 3 (1 urgent)' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Runs · 2' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('region')).toHaveLength(3);

    fireEvent.click(fleet);
    expect(fleet).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Notice 1')).not.toBeInTheDocument();
    expect(screen.getByText('Notice 4')).toBeInTheDocument();

    fireEvent.click(fleet);
    expect(fleet).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Notice 1')).toBeInTheDocument();
  });

  it('keeps a small list flat', () => {
    showItems(items.slice(0, 3));
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Fleet on this Mac ·/ })).not.toBeInTheDocument();
    expect(screen.getByText('Notice 1')).toBeInTheDocument();
    expect(screen.getByText('Notice 3')).toBeInTheDocument();
  });
});
