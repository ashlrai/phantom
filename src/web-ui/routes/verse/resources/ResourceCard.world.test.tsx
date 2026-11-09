/**
 * A card whose own probe has not run shows the world model's fresh reading,
 * with its source and age. A stale reading never reaches the card.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evictAll, runQuery } from '../../../data/cache.js';
import { accountStatus, type CapacityRow } from '../usage/capacity-strip-model.js';
import { projectResourceDisplay } from './resource-display-model.js';
import { ResourceCard } from './ResourceCard.js';
import { worldModelQuery } from './world-query.js';

const ROW: CapacityRow = {
  seatId: 'claude-max', label: 'Claude', engine: 'claude', monogram: 'C', kind: 'subscription', plan: null,
  cls: 'unknown' as CapacityRow['cls'], word: 'no reading', summary: '', connection: null, windows: [], credits: null,
  reserve: null, notes: [], localCount: 1, checkedAt: null, resetAt: null, signedOut: false,
};

function field(value: unknown, ageMs: number, freshness: 'fresh' | 'stale') {
  return { value, source: 'claude-usage', observedAt: new Date(Date.now() - ageMs).toISOString(), freshness };
}

async function seed(freshness: 'fresh' | 'stale', ageMs: number): Promise<void> {
  const doc = { sensors: { lanes: [{ lane: 'claude-max', used: field(40, ageMs, freshness), remaining: field(60, ageMs, freshness), unit: field('percent', ageMs, freshness) }] } };
  await act(async () => { await runQuery(worldModelQuery.key, async () => doc); });
}

function card() {
  const now = Date.now();
  const status = accountStatus(ROW, { now, checking: false });
  render(<ResourceCard row={ROW} status={status} settled={status} display={projectResourceDisplay(ROW, { nowMs: now, healthRead: true })} mode={null} busy={null} onAction={() => {}} />);
}

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); evictAll(); });

describe('ResourceCard world-model reading', () => {
  it('shows the fresh world reading with source and age under a missing usage state', async () => {
    await seed('fresh', 2 * 60_000);
    card();
    expect(screen.getByText('No current usage reading')).toBeTruthy();
    const line = screen.getByText(/^World model:/);
    expect(line.textContent).toContain('World model: 40% · 60%');
    expect(line.textContent).toContain('from claude-usage');
    expect(line.textContent).toContain('2m ago');
  });

  it('shows only the missing text for a stale world row', async () => {
    await seed('stale', 20 * 60_000);
    card();
    expect(screen.getByText('No current usage reading')).toBeTruthy();
    expect(screen.queryByText(/World model:/)).toBeNull();
  });
});
