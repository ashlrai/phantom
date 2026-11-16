import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompactNavStrip } from './CompactNavStrip.js';

describe('CompactNavStrip with five home views', () => {
  it('renders seven buttons in order, with the Needs-you count', () => {
    render(<CompactNavStrip active="leader" needsYouCount={2} onSelect={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Leader', 'Feed', 'Ideas', 'Goals', 'Library', 'Needs you2', 'Fleet']);
    expect(screen.getByLabelText('2 waiting')).toBeTruthy();
  });

  it('selects Goals on click', async () => {
    const onSelect = vi.fn();
    render(<CompactNavStrip active={null} needsYouCount={null} onSelect={onSelect} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Goals' }));
    expect(onSelect).toHaveBeenCalledWith('goals');
  });

  it.each(['ideas', 'goals', 'library'] as const)('marks only %s as current', (active) => {
    render(<CompactNavStrip active={active} needsYouCount={null} onSelect={() => {}} />);
    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current.map((b) => b.textContent?.toLowerCase())).toEqual([active]);
  });
});
