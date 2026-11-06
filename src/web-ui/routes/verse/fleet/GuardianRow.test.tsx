import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GuardianGlanceRow } from '../../../../core/fleet/guardian-glance.js';
import { GuardianRow } from './FleetStatusLink.js';

afterEach(cleanup);
const row = (over: Partial<GuardianGlanceRow>): GuardianGlanceRow =>
  ({ repo: 'r', state: 'green', lastPassAt: null, ageMinutes: 5, openFixes: 0, stale: false, ...over });

describe('GuardianRow', () => {
  it('renders red first, then stale, then green, with ages', () => {
    render(<GuardianRow guardian={[
      row({ repo: 'ok', ageMinutes: 12 }),
      row({ repo: 'old', ageMinutes: 130, stale: true }),
      row({ repo: 'bad', state: 'red', ageMinutes: 3, openFixes: 2 }),
    ]} />);
    const chips = Array.from(screen.getByTestId('guardian-row').querySelectorAll('[title]')).map((el) => el.textContent?.trim());
    expect(chips).toEqual(['bad 3m · 2 fix', 'old 2h', 'ok 12m']);
  });

  it('renders nothing when guardian is absent or empty', () => {
    const { container, rerender } = render(<GuardianRow />);
    expect(container).toBeEmptyDOMElement();
    rerender(<GuardianRow guardian={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
