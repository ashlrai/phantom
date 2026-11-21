/**
 * The live lane list paints mapped rows on the shared usage bar and hatches a lane with no share to draw.
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
  it('renders usage, remaining, reset, burn, source and a fresh badge', () => {
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
    expect(row).toHaveTextContent('Used 40%');
    expect(row).toHaveTextContent('left 60%');
    expect(row).toHaveTextContent('Burn 1%/h');
    expect(row).toHaveTextContent('reset Nov 9, 1:00 PM UTC');
    expect(row).toHaveTextContent('Source claude-usage');
    expect(row).toHaveTextContent('fresh · 2m ago');
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
    expect(dot).toHaveTextContent('Used unknown');
    expect(dot).toHaveTextContent('left unknown');
    expect(dot).toHaveTextContent('stale · 20m ago');
    const hatched = within(dot).getByRole('meter', { name: 'Dot used' });
    expect(hatched).toHaveAttribute('data-unread');
    expect(hatched).not.toHaveAttribute('aria-valuenow');
    expect(hatched.querySelector('[data-part]')).toBeNull();
    expect(dot.querySelector('span[data-ending="unread"]')).toHaveTextContent('no usage reading');
    const missing = screen.getByRole('button', { name: /Cursor cloud: usage unknown/ });
    expect(missing).toHaveAttribute('data-freshness', 'unknown');
    expect(missing).toHaveTextContent('unknown');
    expect(missing.querySelector('[data-part]')).toBeNull();
    expect(document.querySelector('[data-lane-key]')).toBeNull();
  });
});
