import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import type { UsageAuditView } from './usage-audit-queries.js';
import { FleetUsagePane } from './FleetUsagePane.js';
const fixture: UsageAuditView = {
  incidents: 1, sources: { usageJournal: { state: 'healthy' } },
  lanes: (['moving', 'insufficient-evidence', 'idle', 'incident'] as const).map(classification => ({
    lane: classification, classification, pctUsedFirst: classification === 'insufficient-evidence' ? null : 10,
    pctUsedLast: classification === 'insufficient-evidence' ? null : classification === 'moving' ? 13.2 : 10,
    pctUsedDelta: classification === 'insufficient-evidence' ? null : classification === 'moving' ? 3.2 : 0,
    observedMinutes: classification === 'insufficient-evidence' ? null : classification === 'moving' ? 58 : 61,
    reason: `${classification} reason`, nextAction: `${classification} action`,
  })),
};

const props = { visible: true } as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function stub(audit: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/verse/accounts')) return Response.json({ accounts: [] });
    if (url.includes('/api/verse/fleet/runs')) return Response.json({ lanes: [{ lane: 'tokens', tokensLastHour: 20 }] });
    if (url.includes('/api/verse/fleet/usage-audit')) return audit();
    return Response.json({}, { status: 404 });
  }));
}
it('renders the audit between accounts and tokens with verdicts, reasons and action titles', async () => {
  stub(() => Response.json({ v: 1, audit: fixture }));
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Zero waste: 1 incident · 1 idle · 1 moving')).toBeInTheDocument();
  const section = screen.getByRole('region', { name: 'Zero waste (last hour)' });
  const rows = within(section).getAllByRole('listitem');
  expect(rows.map(r => r.title)).toEqual(['incident action', 'idle action', 'insufficient-evidence action', 'moving action']);
  expect(within(section).getByText('+3.2% in 58 min')).toBeInTheDocument();
  expect(within(section).getByText('evidence too thin')).toBeInTheDocument();
  expect(within(section).getByText('incident reason')).toBeInTheDocument();
  expect(section.compareDocumentPosition(screen.getByText('Tokens last hour')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('shows a sanitized failure reason', async () => {
  stub(() => Response.json({ error: 'usage audit unavailable' }, { status: 503 }));
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText('Zero-waste audit unavailable: usage audit unavailable')).toBeInTheDocument();
});
it('polls every minute only while visible', async () => {
  vi.useFakeTimers();
  let calls = 0;
  stub(() => { calls++; return Response.json({ v: 1, audit: fixture }); });
  const view = render(<FleetUsagePane {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(calls).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(calls).toBe(2);
  view.rerender(<FleetUsagePane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(calls).toBe(2);
});
it('keeps a missing route missing across remounts', async () => {
  let calls = 0;
  stub(() => { calls++; return Response.json({}, { status: 404 }); });
  const view = render(<FleetUsagePane {...props} />);
  expect(await screen.findByText(/Zero-waste audit unavailable:/)).toBeInTheDocument();
  view.unmount();
  evictAll();
  render(<FleetUsagePane {...props} />);
  expect(await screen.findByText(/Zero-waste audit unavailable:/)).toBeInTheDocument();
  expect(calls).toBe(1);
});
