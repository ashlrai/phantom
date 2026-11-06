import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capacity, nativeSeat } from '../seat-fixtures.test-support.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { ResourcesBar } from './ResourcesBar.js';
import { RESOURCE_ORDER_KEY, reloadResourceOrderForTest } from './resource-order.js';
import { RESOURCES_STORAGE_KEY, reloadResourcesUiForTest } from './resources-store.js';

vi.mock('../usage/CapacityStrip.js', async original => ({
  ...await original<typeof import('../usage/CapacityStrip.js')>(), useCapacityData: vi.fn(),
}));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: undefined }), useRefetch: () => vi.fn() }));
vi.mock('../shell/section-visibility.js', async original => ({
  ...await original<typeof import('../shell/section-visibility.js')>(), usePollWhileVisible: vi.fn(),
}));
beforeEach(() => {
  localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest();
  vi.mocked(useCapacityData).mockReturnValue({ seats: [
    nativeSeat(capacity(), { id: 'personal', engine: 'codex', label: 'Personal Codex' }),
    nativeSeat(capacity(), { id: 'work', engine: 'codex', label: 'Work Codex' }),
  ], health: null, budget: null, loading: false, refreshing: false, readFailed: false,
  rosterUnavailable: false, pendingSeatIds: [] });
});
afterEach(cleanup);
describe('account rows and supporting evidence', () => {
  it('keeps distinct accounts visible and unbound evidence behind its own disclosure', () => {
    const view = render(<ResourcesBar expanded />);
    expect(view.container.querySelector('[data-resource-id="account:personal"]')).not.toHaveAttribute('hidden');
    expect(view.container.querySelector('[data-resource-id="account:work"]')).not.toHaveAttribute('hidden');
    const evidence = view.container.querySelector('[data-resource-id="codex-personal:sessions"]')!;
    expect(evidence).toHaveAttribute('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Usage sources and budgets (1)' }));
    expect(evidence).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: /Codex personal · session logs:/ })).toBeInTheDocument();
  });
  it('reorders the visible accounts without moving against hidden evidence', () => {
    render(<ResourcesBar expanded />);
    fireEvent.click(screen.getByRole('button', { name: 'Move Work Codex up' }));
    expect(screen.getByRole('status')).toHaveTextContent('Work Codex moved to position 1 of 2.');
    expect(screen.getByRole('button', { name: 'Move Work Codex up' })).toBeDisabled();
  });
});
