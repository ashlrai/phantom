import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { LaneYieldCard } from './LaneYieldCard.js';

const lane = (name: string, launches: number, merged: number, empty: number | null, off = false) => ({
  lane: name, launches, finished: launches, prs_opened: merged, merged, empty_rate: empty, merged_per_launch: merged / launches,
  median_minutes_to_merge: merged ? 3 : null, not_paying_off: off, sentence: `${name}: ${merged} merged PRs from ${launches} launches`,
});
const report = { schema: 'fleet.lane-yield.v1', version: 1, window_hours: 24, known: true, launches: 14, merged: 6,
  summary: 'Last 24 h: 6 merged PRs. Best lane: alpha (0.60 merged per launch). Weakest: delta (0.00).',
  lanes: [lane('alpha', 10, 6, 0.1), lane('beta', 5, 0, 0.6, true), lane('gamma', 3, 0, null, true), lane('delta', 1, 0, 1)] };
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('Yield card', () => {
  it('draws one bar per lane from the report, with merged count, empty rate and a plain warning', async () => {
    installFetch(() => json(report));
    render(<LaneYieldCard />);
    expect(await screen.findByText(report.summary)).toBeVisible();
    expect(screen.getAllByRole('img').map(el => el.getAttribute('aria-label'))[0]).toBe('alpha: 0.60 merged per launch');
    expect(screen.getByText(/6 merged of 10 launches, 10% empty/)).toBeVisible();
    expect(screen.getAllByText(/not paying off/)).toHaveLength(2);
  });

  it('gives the first line and the top three lanes as sentences on a phone', async () => {
    installFetch(() => json(report));
    render(<LaneYieldCard compact />);
    expect(await screen.findByText(report.summary)).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says unknown, never zero bars, when the report cannot be read', async () => {
    installFetch(() => json({ nope: true }));
    render(<LaneYieldCard />);
    expect(await screen.findByText(/Lane yield unknown/)).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
