import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QuietHoursRow } from './QuietHoursRow.js';

describe('QuietHoursRow', () => {
  beforeEach(() => localStorage.clear());
  it('persists its switch and times across remount', () => {
    const view = render(<QuietHoursRow />);
    fireEvent.click(screen.getByRole('switch', { name: 'Quiet hours' }));
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } });
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '08:15' } });
    view.unmount();
    render(<QuietHoursRow />);
    expect(screen.getByRole('switch', { name: 'Quiet hours' })).toBeChecked();
    expect(screen.getByLabelText('Quiet hours start')).toHaveValue('21:30');
    expect(screen.getByLabelText('Quiet hours end')).toHaveValue('08:15');
  });
});
