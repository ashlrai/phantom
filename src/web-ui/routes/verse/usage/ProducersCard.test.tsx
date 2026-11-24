import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { ProducersCard } from './ProducersCard.js';

const report = {
  schema: 'fleet.usage-producers.v1', as_of: '2026-11-18T20:00:00.000Z', hours: 6, metrics: 'ok',
  headline: '5 jobs started in the last 6 h across 2 producers; most from claude-desk (4)',
  producers: [
    { producer: 'claude-desk', kind: 'loop', jobs_started: 4, models: ['sonnet'], wall_minutes: 'unknown', prs_published: 3, prs_merged: 'unknown' },
    { producer: 'zai', kind: 'dispatcher-lane', jobs_started: 1, models: 'unknown', wall_minutes: 12.5, prs_published: 'unknown', prs_merged: 'unknown' },
  ],
  gaps: [{ producer: 'leader', reason: 'no per-pass record' }],
};

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('Who is spending card on the Usage view', () => {
  it('shows one line per producer with unknown spelled out, then the gaps', async () => {
    installFetch(({ path }) => path === '/api/verse/fleet/usage/producers' ? json(report) : json({}, 404));
    render(<ProducersCard />);
    expect(await screen.findByRole('region', { name: 'Who is spending' })).toBeVisible();
    const items = await screen.findAllByRole('listitem');
    expect(within(items[0]!).getByText('4 jobs · sonnet · wall unknown · 3 published · unknown merged')).toBeVisible();
    expect(within(items[1]!).getByText('1 jobs · model unknown · 13 m · unknown published · unknown merged')).toBeVisible();
    expect(within(items[2]!).getByText('no record: no per-pass record')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(report.headline);
  });

  it.each([['an error', () => json({}, 500)], ['another shape', () => json({ lanes: [] })]])('says unknown on %s', async (_name, reply) => {
    installFetch(reply);
    render(<ProducersCard />);
    expect(await screen.findByText('unknown (status unavailable)')).toBeVisible();
  });
});
