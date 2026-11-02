import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSteeringPane } from './FleetSteeringPane.js';

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T11:59:00Z')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(journalMissing = false, runsDir = 'healthy') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('leader-journal')
    ? journalMissing ? Response.json({}, { status: 404 }) : Response.json({
      v: 1, generatedAt: '2026-10-31T11:59:00Z',
      sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
      passes: [{ at: '2026-10-31T11:50:00Z', sections: [{ title: 'Pass', bullets: ['Order acknowledged'] }] }],
      ingest: [], ingested: [], rejectedLastHour: 0,
    }) : Response.json({ sources: { runsDir, inbox: 'healthy' },
      inbox: [{ at: '2026-10-31 07:41', source: 'Phantom desktop', text: 'Keep moving' }],
      events: [{ at: '2026-10-31T07:58:00Z', kind: 'LEADER', text: 'not the journal clock' }],
    })));
  render(<FleetSteeringPane {...({ visible: true } as PaneProps)} />);
}
it('shows the order, journal pass and ETA in one status strip', async () => {
  setup();
  const strip = await screen.findByRole('status', { name: 'Last exchange' });
  expect(strip).toHaveTextContent('You · 07:41 ET · Phantom desktop: Keep moving — Leaders · last pass 07:50 (9 min ago): Order acknowledged · next pass due in about 6 min');
  expect(strip).toHaveAttribute('data-tone', 'ok');
});
it('tolerates a journal 404 as no pass recorded', async () => {
  setup(true);
  expect(await screen.findByRole('status', { name: 'Last exchange' })).toHaveTextContent('Leaders · no pass recorded yet');
  expect(screen.queryByText('Leader journal could not refresh.')).toBeNull();
});
it('explains a missing runs directory', async () => {
  setup(true, 'missing');
  expect(await screen.findByText('No fleet on this Mac yet (~/.ashlr-runs not found).')).toBeInTheDocument();
  expect(screen.queryByText('Inbox or dispatcher events may be incomplete.')).toBeNull();
});
