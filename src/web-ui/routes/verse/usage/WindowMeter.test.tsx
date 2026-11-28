/**
 * WindowMeter.test.tsx: a usage window on the Usage section's account cards, drawn on the shared bar. Pinned
 * where a bar could say more than the reading does: a flagged limit given a number, a prior reading drawn as a
 * current fill, a missing reading drawn as a bar at all, and a time mark without a known start or a clock.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { toWindowView, type WindowView } from './accounts-model.js';
import { projectAccountsSnapshot } from './usage-contract.js';
import { WindowMeter } from './WindowMeter.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
// A week that began five days ago: 5/7 of its time is gone (71.4%).
const RESET = '2026-11-22T12:00:00.000Z';
const WEEK = { startsAt: '2026-11-15T12:00:00.000Z', basis: 'weekly' as const };

function view(over: Partial<WindowView> = {}): WindowView {
  return { id: 'codex', label: 'Week · Codex', usedPct: 62, tone: 'ok', resetText: 'resets Sun 7:00 AM', resetsAt: RESET, limitReached: false, measured: true, ...over };
}

const part = (meter: HTMLElement, name: string) => meter.querySelector<HTMLElement>(`i[data-part="${name}"]`);

describe('WindowMeter', () => {
  it('draws a measured window as the share used, with no time mark when the start is not known', () => {
    const { container } = render(<WindowMeter view={view()} ariaPrefix="Codex A" nowMs={NOW} />);
    const meter = screen.getByRole('meter', { name: 'Codex A Week · Codex used' });
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter).toHaveAttribute('aria-valuetext', '62% used, resets Sun 7:00 AM');
    expect(part(meter, 'used')).toHaveStyle({ width: '62%' });
    expect(part(meter, 'elapsed')).toBeNull();
    expect(container.querySelector('[data-pace]')).toBeNull();
    expect(screen.getByText('resets Sun 7:00 AM')).toBeInTheDocument();
  });

  it('marks the time gone and says how far use sits from an even spend when the start is known', () => {
    const { container } = render(<WindowMeter view={view({ period: WEEK })} ariaPrefix="Codex A" nowMs={NOW} />);
    const meter = screen.getByRole('meter', { name: 'Codex A Week · Codex used' });
    expect(meter).toHaveAttribute('aria-valuetext', '62% used, resets Sun 7:00 AM, 71% of the window gone');
    expect(part(meter, 'elapsed')).toHaveStyle({ left: '71.4%' });
    const pace = container.querySelector('[data-pace]');
    expect(pace).toHaveAttribute('data-pace', 'behind');
    expect(pace).toHaveTextContent(/^71% of the window gone · use is 9 points behind an even spend · began about .+, seven days before its reset$/);
  });

  it('says a provider-reported start is the provider’s, and when use runs ahead', () => {
    const { container } = render(<WindowMeter view={view({ usedPct: 90, tone: 'danger', period: { ...WEEK, basis: 'reported' } })} ariaPrefix="Grok" nowMs={NOW} />);
    const pace = container.querySelector('[data-pace]');
    expect(pace).toHaveAttribute('data-pace', 'ahead');
    expect(pace).toHaveTextContent(/use is 19 points ahead of an even spend · began .+, as the provider reported$/);
    // The figure carries how tight the window is; the bar's fill does not change colour.
    expect(screen.getByText('90%')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByRole('meter')).not.toHaveAttribute('data-ending');
  });

  it('reads nothing against time without the section’s clock, or once the reset has passed', () => {
    const first = render(<WindowMeter view={view({ period: WEEK })} ariaPrefix="Codex A" />);
    expect(first.container.querySelector('[data-pace]')).toBeNull();
    expect(part(screen.getByRole('meter'), 'elapsed')).toBeNull();
    first.unmount();
    const { container } = render(<WindowMeter view={view({ period: WEEK })} ariaPrefix="Codex A" nowMs={Date.parse(RESET) + 60_000} />);
    expect(container.querySelector('[data-pace]')).toBeNull();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '62% used, resets Sun 7:00 AM');
  });

  it('draws a flagged limit as a spent bar with no number, and still marks the time gone', () => {
    const { container } = render(<WindowMeter view={view({ usedPct: null, tone: 'danger', limitReached: true, measured: false, period: WEEK })} ariaPrefix="Codex A" nowMs={NOW} />);
    const meter = screen.getByRole('meter', { name: 'Codex A Week · Codex' });
    expect(meter).toHaveAttribute('data-ending', 'spent');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveAttribute('aria-valuetext', 'the provider flagged this window as rate-limited, so no percentage is shown, 71% of the window gone');
    expect(part(meter, 'used')).toHaveStyle({ width: '100%' });
    expect(screen.getByText('limit reached')).toBeInTheDocument();
    expect(screen.queryByText(/%$/)).toBeNull();
    // A flag is not a measurement, so there is no use to hold against an even spend.
    const pace = container.querySelector('[data-pace]');
    expect(pace).toHaveAttribute('data-pace', 'unread');
    expect(pace).not.toHaveTextContent(/even spend/);
  });

  it('draws a prior reading as a hatched track with its figure marked prior, and no time mark', () => {
    const { container } = render(<WindowMeter view={view({ usedPct: 86, tone: 'warn', period: WEEK })} ariaPrefix="Codex A" historical nowMs={NOW} />);
    const meter = screen.getByRole('meter', { name: 'Codex A Week · Codex prior reading used' });
    expect(meter).toHaveAttribute('data-unread', 'true');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveAttribute('aria-valuetext', 'Prior reading: 86% used, prior report: resets Sun 7:00 AM; current access unconfirmed');
    expect(meter.querySelector('i')).toBeNull();
    expect(screen.getByText('86% · prior')).not.toHaveAttribute('data-tone');
    expect(container.querySelector('[data-pace]')).toBeNull();
  });

  it('never draws a bar for a window with no reading', () => {
    const { container } = render(<WindowMeter view={view({ usedPct: null, period: WEEK })} ariaPrefix="Codex A" nowMs={NOW} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(container.querySelector('[data-window="unknown"] hr')).not.toBeNull();
    expect(container.querySelector('[data-pace]')).toBeNull();
  });
});

describe('toWindowView: the window start', () => {
  const window = (resetProvenance: unknown) => {
    const snapshot = projectAccountsSnapshot({ accounts: [{ id: 'codex-a', provider: 'codex', state: 'observed', authentication: 'signed-in',
      windows: [{ id: 'codex', usedPercent: 62, resetsAt: RESET, ...(resetProvenance === undefined ? {} : { resetProvenance }) }] }] });
    return toWindowView(snapshot!.accounts[0]!.windows[0]!, NOW);
  };

  it('carries the start the server’s reset provenance gives', () => {
    expect(window({ kind: 'weekly-deadline', at: RESET }).period).toEqual(WEEK);
  });

  it('has no period key without provenance, or when the provenance names another reset', () => {
    expect('period' in window(undefined)).toBe(false);
    expect('period' in window({ kind: 'weekly-deadline', at: '2026-11-29T12:00:00.000Z' })).toBe(false);
  });
});
