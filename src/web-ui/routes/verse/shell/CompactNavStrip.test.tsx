import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompactNavStrip } from './CompactNavStrip.js';

describe('CompactNavStrip', () => {
  it('renders the four items with the Needs-you count', () => {
    render(<CompactNavStrip active="leader" needsYouCount={3} onSelect={() => {}} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Leader', 'Feed', 'Needs you3', 'Fleet']);
    expect(screen.getByLabelText('3 waiting')).toBeTruthy();
  });

  it('shows no count badge when nothing is waiting', () => {
    render(<CompactNavStrip active={null} needsYouCount={0} onSelect={() => {}} />);
    expect(screen.queryByLabelText(/waiting/)).toBeNull();
  });

  it('marks only the active item with aria-current', () => {
    render(<CompactNavStrip active="feed" needsYouCount={null} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Feed' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Leader' }).hasAttribute('aria-current')).toBe(false);
  });

  it('switches the view on click and from the keyboard', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<CompactNavStrip active="leader" needsYouCount={null} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(onSelect).toHaveBeenLastCalledWith('fleet');
    screen.getByRole('button', { name: 'Feed' }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('feed');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
