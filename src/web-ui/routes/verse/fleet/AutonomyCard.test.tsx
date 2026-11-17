import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { AutonomyReport } from '../../../../core/fleet/autonomy.js';
import { evictAll } from '../../../data/cache.js';
import { AutonomyCard } from './AutonomyCard.js';

const report: AutonomyReport = {
  schema: 'fleet.autonomy.v1', windowHours: 24, generatedAt: '2026-11-17T12:00:00.000Z',
  merged: 24, mergedPerHour: 1, withoutHumanShare: 1, selfImprovementShare: 0.5,
  actorsKnown: 24, filesKnown: 24, malformedLines: 0, pathRules: [],
  releases: 2, mainGreenShare: 1, headline: '24 merged, 100% without a person, 50% improved the fleet itself',
};
beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

it('renders the shared headline and three accessible metrics through a read-only request', async () => {
  serve(report);
  render(<AutonomyCard />);
  const card = within(screen.getByRole('region', { name: 'Autonomy' }));
  expect(card.getByText('Reading autonomy…')).toBeInTheDocument();
  expect(await card.findByText(report.headline)).toBeInTheDocument();
  for (const [label, value] of [['Merged per hour', '1'], ['Without a person', '100%'], ['Improved the fleet', '50%']] as const) {
    expect(card.getByText(label).nextElementSibling).toHaveTextContent(value);
  }
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/runs/autonomy', expect.objectContaining({ method: 'GET' }));
});

it.each([false, true])('renders unknown rather than zero when evidence is missing or the request fails (%s)', async failed => {
  serve({ ...report, mergedPerHour: null, withoutHumanShare: null, selfImprovementShare: null, headline: 'Merged count unknown.' }, failed ? 503 : 200);
  render(<AutonomyCard />);
  expect(await screen.findByText(failed ? 'Autonomy is unknown. Local evidence is unavailable.' : 'Merged count unknown.')).toBeInTheDocument();
  expect(screen.getAllByText('Unknown')).toHaveLength(3);
  expect(screen.queryByText('0%')).not.toBeInTheDocument();
});
