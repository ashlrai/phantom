import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AtRiskReading } from './AtRiskReading.js';
import type { AtRiskValue } from './at-risk-model.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const RISK: AtRiskValue = { resource: 'claude', percentUnused: 50, resetAt: '2026-11-17T22:00:00.000Z', reason: '50.0% will expire unused in 10.0h at current burn.', usedPercent: 40, burnPctPerHour: 1 };
const parts = (meter: HTMLElement) => [...meter.querySelectorAll('i')].map(part => [part.getAttribute('data-part'), part.style.width]);
afterEach(cleanup);

describe('AtRiskReading', () => {
  it('draws the window as used now, more by the reset and left over, and keeps the summary\'s own sentence', () => {
    render(<AtRiskReading risk={RISK} now={NOW} />);
    const meter = screen.getByRole('meter', { name: 'claude used by its reset' });
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
    expect(meter.getAttribute('aria-valuetext')).toBe('40% used now, 10% more by its reset at 1% an hour, 50% left over');
    expect(parts(meter)).toEqual([['used', '40%'], ['more', '10%'], ['unused', '50%']]);
    const key = within(screen.getByRole('list', { name: 'How this window ends' })).getAllByRole('listitem');
    expect(key.map(item => item.textContent)).toEqual(['40% used now', '10% more by its reset at 1% an hour', '50% left over']);
    expect(screen.getByText('50%').tagName).toBe('STRONG');
    expect(screen.getByText('claude. 50.0% will expire unused in 10.0h at current burn.')).toBeTruthy();
    const when = screen.getByText(/^resets in 10 h · /);
    expect(when.hasAttribute('data-unknown')).toBe(false);
  });

  it('marks a reset that has passed as no reading instead of counting down to it', () => {
    render(<AtRiskReading risk={RISK} now={NOW + 11 * 3_600_000} />);
    expect(screen.getByText('its reset time has passed; waiting for a new reading').hasAttribute('data-unknown')).toBe(true);
    expect(screen.queryByText(/^resets in/)).toBeNull();
  });

  it('draws two shares for a summary without the reading', () => {
    render(<AtRiskReading risk={{ resource: 'grok', percentUnused: 25, resetAt: RISK.resetAt, reason: '25.0% will expire unused in 10.0h at current burn.' }} now={NOW} />);
    const meter = screen.getByRole('meter', { name: 'grok used by its reset' });
    expect(parts(meter)).toEqual([['more', '75%'], ['unused', '25%']]);
    expect(meter.getAttribute('aria-valuetext')).toBe('75% used by its reset, 25% left over');
  });
});
