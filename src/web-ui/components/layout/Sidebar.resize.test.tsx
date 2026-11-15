import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar.js';
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_KEY, clampSidebarWidth } from './sidebar-width.js';

// Router context is irrelevant to resizing; a plain anchor stands in for NavLink.
vi.mock('react-router-dom', () => ({
  NavLink: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

const setup = () => render(<Sidebar />);
// jsdom's PointerEvent drops clientX; a MouseEvent of the same type carries it.
const move = (clientX: number) => act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX })); });
const down = (clientX: number) => fireEvent(handle(), new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX }));
const handle = () => screen.getByRole('separator', { name: 'Resize sidebar' });

describe('Sidebar resize', () => {
  beforeEach(() => window.localStorage.clear());

  it('clamps to 200–480 and rejects junk', () => {
    expect(clampSidebarWidth(50)).toBe(200);
    expect(clampSidebarWidth(9999)).toBe(480);
    expect(clampSidebarWidth('abc')).toBe(SIDEBAR_WIDTH.def);
  });

  it('drags live, clamps, and persists', () => {
    setup();
    down(240);
    move(300);
    expect(handle().getAttribute('aria-valuenow')).toBe('300');
    move(2000);
    expect(handle().getAttribute('aria-valuenow')).toBe('480');
    act(() => { fireEvent.pointerUp(window, { pointerId: 1 }); });
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('480');
    expect(document.body.dataset['shellResizing']).toBeUndefined();
  });

  it('restores the start width on Escape', () => {
    setup();
    down(240);
    move(400);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(handle().getAttribute('aria-valuenow')).toBe('240');
  });

  it('supports keyboard and double-click reset', () => {
    setup();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(handle().getAttribute('aria-valuenow')).toBe('256');
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(handle().getAttribute('aria-valuenow')).toBe('200');
    fireEvent.doubleClick(handle());
    expect(handle().getAttribute('aria-valuenow')).toBe('240');
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  });

  it('restores a persisted width and keeps nav links', () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, '333');
    setup();
    expect(handle().getAttribute('aria-valuenow')).toBe('333');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });
});
