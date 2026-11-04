/**
 * UsageResourcesCard.test.tsx — RQ-NIGHT-USAGE-1: the mobile "Every resource"
 * card renders the same twelve rows as the desktop grid, in one column of
 * stacked Rows. The 390 px snapshot is the mobile acceptance: every resource
 * reads as its own full-width row.
 */
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { USAGE_RESOURCES } from '../../../../core/usage/resource-usage-types.js';
import { UsageResourcesCard } from './UsageResourcesCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

function wire(overrides: Partial<Record<string, Record<string, unknown>>> = {}) {
  return {
    v: 1,
    generatedAt: '2026-11-02T12:00:00.000Z',
    resources: USAGE_RESOURCES.map(({ id, label }) => ({
      id, label, state: 'no-reader', used: null, limit: null, unit: null,
      resetsAt: null, source: null, asOf: null, reason: null,
      ...overrides[id],
    })),
  };
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('UsageResourcesCard', () => {
  it('lists all twelve resources; a no-reader row says so and shows nothing measured', async () => {
    const stub = stubFetch({ 'GET /api/verse/usage-resources': wire() });
    renderMobile(<UsageResourcesCard />);
    expect(await screen.findByText('Ultra (Cursor + Grok pool)')).toBeInTheDocument();
    for (const { label } of USAGE_RESOURCES) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('No reader yet')).toHaveLength(12);
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/verse/usage-resources']);
  });

  it('lets codex and devin readings reach their rows', async () => {
    stubFetch({ 'GET /api/verse/usage-resources': wire({
      'codex-cmp': { state: 'ok', used: 62, limit: 100, unit: 'percent',
        resetsAt: '2026-11-05T12:00:00.000Z', source: 'codex-session-logs', asOf: '2026-11-02T11:00:00.000Z' },
      devin: { state: 'ok', used: 1240, limit: 2000, unit: 'acu',
        resetsAt: '2026-12-01T00:00:00.000Z', source: 'devin-api-v3-org-cycle', asOf: '2026-11-02T11:59:00.000Z' },
    }) });
    renderMobile(<UsageResourcesCard />);
    expect(await screen.findByText('62% used')).toBeInTheDocument();
    expect(screen.getByText('1,240 of 2,000 ACU')).toBeInTheDocument();
    expect(screen.getByText(/codex-session-logs/)).toBeInTheDocument();
    expect(screen.getByText(/devin-api-v3-org-cycle/)).toBeInTheDocument();
    expect(screen.getAllByText('No reader yet')).toHaveLength(10);
  });

  it('degrades honestly when the route is absent', async () => {
    stubFetch({ 'GET /api/verse/usage-resources': json({ error: 'not found' }, 404) });
    renderMobile(<UsageResourcesCard />);
    expect(await screen.findByText(/does not expose \/api\/verse\/usage-resources yet/)).toBeInTheDocument();
  });

  it('at 390 px every resource is its own full-width row in one column', async () => {
    stubFetch({ 'GET /api/verse/usage-resources': wire({
      'codex-cmp': { state: 'ok', used: 62, limit: 100, unit: 'percent',
        resetsAt: '2026-11-05T12:00:00.000Z', source: 'codex-session-logs', asOf: '2026-11-02T11:00:00.000Z' },
      devin: { state: 'ok', used: 1240, limit: 2000, unit: 'acu',
        resetsAt: '2026-12-01T00:00:00.000Z', source: 'devin-api-v3-org-cycle', asOf: '2026-11-02T11:59:00.000Z' },
    }) });
    const view = renderMobile(
      <div style={{ width: '390px' }}>
        <UsageResourcesCard />
      </div>,
    );
    await screen.findByText('Ultra (Cursor + Grok pool)');
    // The card is a flat stack of Row blocks inside one named section — each
    // resource keeps its own full-width row at phone width, in roster order.
    const region = screen.getByRole('region', { name: 'Every resource' });
    const group = region.children[1] as HTMLElement;
    const rows = [...group.children] as HTMLElement[];
    expect(rows).toHaveLength(12);
    rows.forEach((row, i) => {
      // Each block carries exactly one resource — nothing is nested or
      // laid out side by side inside a row.
      const labels = USAGE_RESOURCES.filter((r) => row.textContent?.includes(r.label));
      expect(labels.map((r) => r.id)).toEqual([USAGE_RESOURCES[i]!.id]);
    });
    expect(view.container).toHaveTextContent('No reader yet');
  });
});
