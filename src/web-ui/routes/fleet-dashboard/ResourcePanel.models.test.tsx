import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResourcePanel } from './ResourcePanel.js';

const state = vi.hoisted(() => ({ models: undefined as unknown }));
const view = { pools: [], machine: { memFreePct: null, swapUsedPct: null, diskFreePct: null, admission: 'unknown' }, localModels: { count: 2 } };
vi.mock('../../data/hooks.js', () => ({
  useQuery: (def: { key: string }) => ({ status: 'success', data: def.key === 'verse-model-check' ? state.models : view }),
  useRefetch: () => () => {}, useRefresh: () => () => {},
}));

describe('Models row on the resources panel', () => {
  it('counts verified and unverified models, stale and unconfirmed together', () => {
    state.models = { registry: 'ok', counts: { confirmed: 3, stale: 1, unconfirmed: 2 } };
    render(<ResourcePanel />);
    expect(screen.getByText('Models').nextElementSibling).toHaveTextContent('3 verified, 3 unverified');
  });
  it('says unknown when the check is unreadable', () => {
    state.models = undefined;
    render(<ResourcePanel />);
    expect(screen.getByText('Models').nextElementSibling).toHaveTextContent(/^unknown/);
  });
});
