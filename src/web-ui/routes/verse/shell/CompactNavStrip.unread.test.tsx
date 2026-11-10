import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompactNavStrip } from './CompactNavStrip.js';

describe('CompactNavStrip unread chips', () => {
  it('shows one "3 new" chip on Leader when Leader 3 / Feed 0', () => {
    render(<CompactNavStrip active="feed" needsYouCount={null} unread={{ leader: 3, feed: 0 }} onSelect={() => {}} />);
    expect(screen.getAllByLabelText(/ new$/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Leader/ }).textContent).toBe('Leader3');
    expect(screen.getByLabelText('3 new')).toBeTruthy();
  });

  it('shows no chip on the active item', () => {
    render(<CompactNavStrip active="leader" needsYouCount={null} unread={{ leader: 3, feed: 0 }} onSelect={() => {}} />);
    expect(screen.queryByLabelText(/ new$/)).toBeNull();
  });

  it('caps the chip text at 99+', () => {
    render(<CompactNavStrip active="leader" needsYouCount={null} unread={{ leader: 0, feed: 150 }} onSelect={() => {}} />);
    expect(screen.getByLabelText('150 new').textContent).toBe('99+');
  });

  it('keeps the Needs-you chip next to the new chips', () => {
    render(<CompactNavStrip active={null} needsYouCount={1} unread={{ leader: 3, feed: 2 }} onSelect={() => {}} />);
    expect(screen.getByLabelText('1 waiting')).toBeTruthy();
    expect(screen.getAllByLabelText(/ new$/)).toHaveLength(2);
  });
});
