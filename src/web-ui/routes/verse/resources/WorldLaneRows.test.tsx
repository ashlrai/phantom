/**
 * The live lane list paints mapped rows and leaves unknown forecasts unlabeled.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldLaneRows } from './WorldLaneRows.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const RECENT = new Date(NOW - 2 * 60_000).toISOString();

function field(value: unknown, freshness: 'fresh' | 'stale' | 'unknown' = 'fresh') {
  return { value, source: 'claude-usage', observedAt: freshness === 'stale' ? new Date(NOW - 20 * 60_000).toISOString() : RECENT, freshness };
}

afterEach(() => { cleanup(); });

describe('WorldLaneRows', () => {
  it('renders one compact row: usage, a reset countdown and a live chip; burn and source stay in the tooltip', () => {
    const resetAt = new Date(NOW + 3_600_000).toISOString();
    render(<WorldLaneRows expanded now={NOW} snapshot={{
      sensors: { lanes: [{
        lane: 'claude-max',
        used: field(40),
        remaining: field(60),
        burnRate: field(1),
        unit: field('percent'),
        resetAt: field(resetAt),
        forecastVsReset: field('underuse'),
      }] },
    }} />);
    const row = screen.getByRole('button', { name: /Claude subscription/ });
    expect(row).toHaveAttribute('data-freshness', 'fresh');
    expect(row).toHaveTextContent('Used 40% · 60% left · allowance left at reset');
    expect(row).toHaveTextContent('resets in 1h');
    expect(row).toHaveTextContent('live · 2m');
    expect(row).not.toHaveTextContent('Burn');
    expect(row).not.toHaveTextContent('Source');
    expect(row).not.toHaveTextContent('unknown');
    expect(screen.getByRole('group', { name: 'Claude resources' })).toContainElement(row);
        const meter = within(row).getByRole('meter', { name: 'Claude subscription used' });
    expect(meter).toHaveAttribute('aria-valuenow', '40');
    expect(meter).toHaveAttribute('aria-valuetext', '40% used; 1% more by the reset at the measured burn; 59% left unused');
    expect(meter).toHaveAttribute('data-size', 'bar');
    expect(meter).toHaveAttribute('data-ending', 'unused');
    expect(meter.querySelector('[data-part="used"]')).toHaveStyle({ width: '40%' });
    expect(meter.querySelector('[data-part="more"]')).toHaveStyle({ width: '1%' });
    expect(meter.querySelector('[data-part="unused"]')).toHaveStyle({ width: '59%' });
    expect(row.querySelector('[data-figure]')).toHaveTextContent('40%');
    expect(row.querySelector('span[data-ending="unused"]')).toHaveTextContent('59% left unused at the reset');
    expect(document.querySelector('[data-lane-key]')).toHaveTextContent('usedmore by the resetunused then');

  });

  it('fills a lane that runs dry before its reset to the end, and a lane with no forecast only as far as it is used', () => {
    const resetAt = new Date(NOW + 10 * 3_600_000).toISOString();
    render(<WorldLaneRows expanded now={NOW} snapshot={{
      sensors: { lanes: [
        { lane: 'claude-max', used: field(42), limit: field(100), burnRate: field(14.5), unit: field('percent'), resetAt: field(resetAt), forecastVsReset: field('early') },
        { lane: 'devin', used: field(3), limit: field(10), unit: field('acu') },
        { lane: 'local', used: field(8) },
      ] },
    }} />);
    const dry = screen.getByRole('meter', { name: 'Claude subscription used' });
    expect(dry).toHaveAttribute('data-ending', 'dry');
    expect(dry.querySelector('[data-part="used"]')).toHaveStyle({ width: '42%' });
    expect(dry.querySelector('[data-part="more"]')).toHaveStyle({ width: '58%' });
    expect(dry.querySelector('[data-part="unused"]')).toBeNull();
    const open = screen.getByRole('meter', { name: 'Devin used' });
    expect(open).toHaveAttribute('aria-valuenow', '30');
    expect(open).toHaveAttribute('aria-valuetext', '30% used; nothing projected');
    expect(open.querySelector('[data-part="used"]')).toHaveStyle({ width: '30%' });
    expect(open.querySelector('[data-part="more"]')).toBeNull();
    const local = screen.getByRole('meter', { name: 'Local / oMLX used' });
    expect(local).toHaveAttribute('data-unread');
    expect(local).not.toHaveAttribute('aria-valuenow');
    expect(local).toHaveAttribute('aria-valuetext', 'no limit recorded, so no share');
    expect(screen.getByRole('button', { name: /Local \/ oMLX/ }).querySelector('[data-figure]')).toBeNull();
  });

  it('draws the same window as an edge in the collapsed rail, without the words or the key', () => {
    render(<WorldLaneRows expanded={false} now={NOW} snapshot={{
      sensors: { lanes: [{ lane: 'claude-max', used: field(40), burnRate: field(1), unit: field('percent'),
        resetAt: field(new Date(NOW + 3_600_000).toISOString()), forecastVsReset: field('underuse') }] },
    }} />);
    const row = screen.getByRole('button', { name: /Claude subscription/ });
    const meter = within(row).getByRole('meter', { name: 'Claude subscription used' });
    expect(meter).toHaveAttribute('data-size', 'edge');
    expect(meter.querySelector('[data-part="used"]')).toHaveStyle({ width: '40%' });
    expect(row.querySelector('[data-figure]')).toBeNull();
    expect(row.querySelector('span[data-ending]')).toBeNull();
    expect(document.querySelector('[data-lane-key]')).toBeNull();
  });

  it('renders stale and unknown lanes without inventing a gauge fill', () => {
    render(<WorldLaneRows expanded now={NOW} snapshot={{
      sensors: { lanes: [{ lane: 'dot', used: field(15, 'stale'), remaining: field(85, 'stale') }] },
    }} />);
    const dot = screen.getByRole('button', { name: /Dot:/ });
    expect(dot).toHaveAttribute('data-freshness', 'stale');
    expect(dot).toHaveTextContent('stale · 20m ago');
    expect(dot).not.toHaveTextContent('unknown');
    expect(within(dot).getByRole('meter')).toHaveAttribute('data-unread');
    const missing = screen.getByRole('button', { name: /Cursor cloud: usage unknown/ });
    expect(missing).toHaveAttribute('data-freshness', 'unknown');
    expect(missing).toHaveTextContent('Cursor cloudnot connectedNot measured yet · connect');
    expect(dot).not.toHaveTextContent('Not measured yet');
    expect(within(missing).getByRole('meter')).toHaveAttribute('data-unread');
  });

  it('renders usage history and the exhaust marker inside the redesigned provider card', () => {
    const resetAt = new Date(NOW + 3_600_000).toISOString();
    const exhaustAt = new Date(NOW + 1_800_000).toISOString();
    render(<WorldLaneRows expanded now={NOW} snapshot={{
      sensors: { lanes: [{
        lane: 'claude-max',
        used: field(50),
        limit: field(100),
        remaining: field(50),
        unit: field('percent'),
        resetAt: field(resetAt),
        forecastExhaustAt: field(exhaustAt),
        forecastVsReset: field('early'),
        history: {
          points: [
            { observedAt: RECENT, used: 25, limit: 100 },
            { observedAt: new Date(NOW).toISOString(), used: 50, limit: 100 },
          ],
          burn: { perHour: 4 },
          exhaustAt,
          resetAt,
        },
      }] },
    }} />);
    const provider = screen.getByRole('group', { name: 'Claude resources' });
    const row = screen.getByRole('button', { name: /Claude subscription/ });
    const sparkline = screen.getByRole('img', { name: 'Burn history, 2 measured points' });
    expect(provider).toContainElement(row);
    expect(row).toContainElement(sparkline);
    expect(within(row).getByRole('meter')).toHaveAttribute('aria-valuenow', '50');
    expect(row.querySelector('[data-exhaust="before-reset"]')).not.toBeNull();
  });

  it('keeps the unknown gauge in the collapsed rail so every lane still has a meter', () => {
    render(<WorldLaneRows expanded={false} now={NOW} snapshot={{ sensors: { lanes: [] } }} />);
    const missing = screen.getByRole('button', { name: /Cursor cloud: usage unknown/ });
    expect(within(missing).getByRole('meter')).toHaveAttribute('data-unread');
    expect(missing).toHaveTextContent('?');
  });
});
