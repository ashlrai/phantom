/**
 * The live lane list paints mapped rows and leaves unknown forecasts unlabeled.
 */
import { cleanup, render, screen } from '@testing-library/react';
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
        forecastVsReset: field('on-pace'),
      }] },
    }} />);
    const row = screen.getByRole('button', { name: /Claude subscription/ });
    expect(row).toHaveAttribute('data-freshness', 'fresh');
    expect(row).toHaveTextContent('Used 40% · 60% left · meets reset');
    expect(row).toHaveTextContent('resets in 1h');
    expect(row).toHaveTextContent('live · 2m');
    expect(row).not.toHaveTextContent('Burn');
    expect(row).not.toHaveTextContent('Source');
    expect(row).not.toHaveTextContent('unknown');
    expect(screen.getByRole('group', { name: 'Claude resources' })).toContainElement(row);
    expect(row.querySelector('[data-forecast="on-pace"]')).toHaveAttribute('data-gauge', 'qualitative');
  });

  it('renders stale and unknown lanes without inventing a gauge fill', () => {
    render(<WorldLaneRows expanded now={NOW} snapshot={{
      sensors: { lanes: [{ lane: 'dot', used: field(15, 'stale'), remaining: field(85, 'stale') }] },
    }} />);
    const dot = screen.getByRole('button', { name: /Dot:/ });
    expect(dot).toHaveAttribute('data-freshness', 'stale');
    expect(dot).toHaveTextContent('stale · 20m ago');
    expect(dot).not.toHaveTextContent('unknown');
    expect(dot.querySelector('[data-gauge]')).toBeNull();
    const missing = screen.getByRole('button', { name: /Cursor cloud: usage unknown/ });
    expect(missing).toHaveAttribute('data-freshness', 'unknown');
    expect(missing).toHaveTextContent('Cursor cloudnot connectedNot measured yet · connect');
    expect(dot).not.toHaveTextContent('Not measured yet');
    expect(missing.querySelector('[data-gauge]')).toBeNull();
  });

  it('keeps the unknown gauge in the collapsed rail so every lane still has a meter', () => {
    render(<WorldLaneRows expanded={false} now={NOW} snapshot={{ sensors: { lanes: [] } }} />);
    const missing = screen.getByRole('button', { name: /Cursor cloud: usage unknown/ });
    expect(missing.querySelector('[data-forecast="unknown"]')).toHaveAttribute('data-gauge', 'unknown');
    expect(missing).toHaveTextContent('?');
  });
});
