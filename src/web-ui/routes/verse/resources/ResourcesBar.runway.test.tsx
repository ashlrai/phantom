import { cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { capacity, nativeSeat } from '../seat-fixtures.test-support.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { readings, recordReading, resetReadings, type PersonalReading } from '../usage/codex-burn-model.js';
import { personalReader } from '../usage/codex-burn-queries.js';
import { ResourcesBar } from './ResourcesBar.js';
import { RESOURCE_ORDER_KEY, reloadResourceOrderForTest } from './resource-order.js';
import { closeResources, reloadResourcesUiForTest, RESOURCES_STORAGE_KEY } from './resources-store.js';

vi.mock('../usage/CapacityStrip.js', async (original) => ({
  ...await original<typeof import('../usage/CapacityStrip.js')>(), useCapacityData: vi.fn(),
}));
vi.mock('../usage/codex-burn-queries.js', () => ({ personalReader: vi.fn() }));

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const reading: PersonalReading = { usedPct: 92, resetsAt: '2026-11-04T12:00:00.000Z', asOf: '2026-10-31T11:57:00.000Z', sourceState: 'healthy' };
const earlier: PersonalReading = { ...reading, usedPct: 90, asOf: '2026-10-31T10:57:00.000Z' };

beforeEach(() => {
  resetReadings(); evictAll(); localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
  vi.mocked(useCapacityData).mockReturnValue({ seats: [nativeSeat(capacity(), { id: 'codex-seat', engine: 'codex', label: 'Codex seat' })],
    health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
  vi.mocked(personalReader).mockReturnValue(async () => ({ missing: false, reading, sourceState: 'healthy' }));
  installFetch(() => json({}));
});
afterEach(() => {
  cleanup(); resetReadings(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
});

function mount() {
  return render(<SectionVisibilityProvider visible><ResourcesBar expanded now={NOW} /></SectionVisibilityProvider>);
}

describe('personal Codex runway in the resources bar', () => {
  it('shows the projected time and pace from shared history', async () => {
    recordReading(earlier, NOW); recordReading(reading, NOW);
    const view = mount();
    const row = view.container.querySelector('[data-resource-id="codex-personal:sessions"]') as HTMLElement;
    await waitFor(() => expect(row).toHaveTextContent('92% used · out near'));
    expect(within(row).getByRole('button', { name: /out near .* at 2\.0%\/h/ })).toBeInTheDocument();
  });

  it('records a healthy arrival and reports unknown pace until another sample arrives', async () => {
    const view = mount();
    const row = view.container.querySelector('[data-resource-id="codex-personal:sessions"]') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('button', { name: /pace unknown yet/ })).toBeInTheDocument());
    await waitFor(() => expect(readings()).toEqual([{ at: Date.parse(reading.asOf!), usedPct: 92 }]));
    view.rerender(<SectionVisibilityProvider visible><ResourcesBar expanded now={NOW} /></SectionVisibilityProvider>);
    expect(readings()).toHaveLength(1);
  });
});
