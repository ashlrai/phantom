/**
 * UsageResourcesPanel.test.tsx — RQ-NIGHT-USAGE-1: the desktop "Every
 * resource" grid must render all twelve rows, label a resource with no
 * reader "No reader yet" (never a fake number), and let the existing
 * codex/devin readers feed their rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { USAGE_RESOURCES } from '../../../../core/usage/resource-usage-types.js';
import { UsageResourcesPanel } from './UsageResourcesPanel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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

function stubResources(body: unknown, status = 200) {
  return vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input) === '/api/verse/usage-resources' ? json(body, status) : json({ error: 'not found' }, 404)));
}

afterEach(() => {
  cleanup();
  evictAll();
  vi.unstubAllGlobals();
});

describe('UsageResourcesPanel', () => {
  it('renders all twelve rows, in roster order', async () => {
    stubResources(wire());
    render(<UsageResourcesPanel />);
    const grid = await screen.findByRole('list');
    const cells = within(grid).getAllByRole('listitem');
    expect(cells).toHaveLength(12);
    expect(cells.map((cell) => cell.getAttribute('data-resource'))).toEqual(USAGE_RESOURCES.map((r) => r.id));
    for (const { label } of USAGE_RESOURCES) {
      expect(within(grid).getByText(label)).toBeInTheDocument();
    }
  });

  it('labels a resource with no reader "No reader yet" and shows no meter or numbers', async () => {
    stubResources(wire());
    render(<UsageResourcesPanel />);
    await screen.findByRole('list');
    for (const id of ['zai', 'agy', 'gemini-workspace', 'local', 'stacksync']) {
      const cell = document.querySelector(`[data-resource="${id}"]`)!;
      expect(within(cell as HTMLElement).getByText('No reader yet')).toBeInTheDocument();
      expect(within(cell as HTMLElement).queryByRole('meter')).toBeNull();
      // No measured-looking figure may appear: no amounts, no percentages.
      expect(cell.textContent).not.toMatch(/\d/);
    }
  });

  it('lets the codex and devin readers feed their rows', async () => {
    stubResources(wire({
      'codex-cmp': { state: 'ok', used: 62, limit: 100, unit: 'percent',
        resetsAt: '2026-11-05T12:00:00.000Z', source: 'codex-session-logs', asOf: '2026-11-02T11:00:00.000Z' },
      devin: { state: 'ok', used: 1240, limit: 2000, unit: 'acu',
        resetsAt: '2026-12-01T00:00:00.000Z', source: 'devin-api-v3-org-cycle', asOf: '2026-11-02T11:59:00.000Z' },
    }));
    render(<UsageResourcesPanel />);
    await screen.findByRole('list');
    const cmp = document.querySelector('[data-resource="codex-cmp"]') as HTMLElement;
    expect(within(cmp).getByRole('meter')).toHaveAttribute('aria-valuenow', '62');
    expect(within(cmp).getByText('62% used')).toBeInTheDocument();
    expect(within(cmp).getByText('codex-session-logs')).toBeInTheDocument();
    const devin = document.querySelector('[data-resource="devin"]') as HTMLElement;
    expect(within(devin).getByText('1,240 of 2,000 ACU')).toBeInTheDocument();
    expect(within(devin).getByText('devin-api-v3-org-cycle')).toBeInTheDocument();
  });

  it('names an unavailable read instead of showing numbers', async () => {
    stubResources(wire({ devin: { state: 'unavailable', reason: 'reader-timeout' } }));
    render(<UsageResourcesPanel />);
    await screen.findByRole('list');
    const devin = document.querySelector('[data-resource="devin"]') as HTMLElement;
    expect(within(devin).getByText('Read failed')).toBeInTheDocument();
    expect(within(devin).getByText('reader timed out')).toBeInTheDocument();
    expect(within(devin).queryByRole('meter')).toBeNull();
  });

  it('says when the route or payload is unavailable instead of guessing', async () => {
    stubResources({ error: 'not found' }, 404);
    render(<UsageResourcesPanel />);
    expect(await screen.findByText(/does not expose \/api\/verse\/usage-resources yet/)).toBeInTheDocument();
  });
});
