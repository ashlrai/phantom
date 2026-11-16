import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UsagePaceChip } from './UsagePaceChip.js';

const now = Date.parse('2026-11-10T12:00:00Z');
const input = { usedFrac: 0.5, ratePerHour: 0.04, resetAt: '2026-11-10T22:00:00Z', now };
afterEach(cleanup);
describe('UsagePaceChip', () => {
  it('shows each projection and its inputs', () => {
    const { rerender } = render(<UsagePaceChip {...input} />);
    expect(screen.getByText('On pace').getAttribute('title')).toContain('Used: 50%; rate per hour: 4%; reset: 2026-11-10T22:00:00Z; now:');
    rerender(<UsagePaceChip {...input} ratePerHour={0} />);
    expect(screen.getByText('Will waste ~50%')).toBeTruthy();
    rerender(<UsagePaceChip {...input} ratePerHour={0.1} />);
    expect(screen.getByText(/^Runs out ~/)).toBeTruthy();
    rerender(<UsagePaceChip {...input} ratePerHour={null} />);
    expect(screen.getByText('unknown').getAttribute('title')).toContain('rate per hour: unknown');
  });
});
