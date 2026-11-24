import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourcePanel } from './ResourcePanel.js';

const state = vi.hoisted(() => ({ models: undefined as unknown, status: 'success' }));
const view = { pools: [], machine: { memFreePct: null, swapUsedPct: null, diskFreePct: null, admission: 'unknown' }, localModels: { count: 2 } };
vi.mock('../../data/hooks.js', () => ({
  useQuery: (def: { key: string }) => def.key === 'verse-model-check'
    ? { status: state.status, data: state.models } : { status: 'success', data: view },
  useRefetch: () => () => {}, useRefresh: () => () => {},
}));

describe('Models row on the resources panel', () => {
  beforeEach(() => { state.models = undefined; state.status = 'success'; });
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
  it('keeps measured zero counts distinct from unknown', () => {
    state.models = { registry: 'ok', counts: { confirmed: 0, stale: 0, unconfirmed: 0 } };
    render(<ResourcePanel />);
    expect(screen.getByText('Models').nextElementSibling).toHaveTextContent('0 verified, 0 unverified');
  });
  it.each([
    { registry: 'unknown', counts: { confirmed: 3, stale: 1, unconfirmed: 2 } },
    { registry: 'ok' },
  ])('says unknown when registry evidence or counts are unavailable: %j', report => {
    state.models = report;
    render(<ResourcePanel />);
    expect(screen.getByText('Models').nextElementSibling).toHaveTextContent(/^unknown/);
  });
  it('does not present cached counts as current after a failed read', () => {
    state.models = { registry: 'ok', counts: { confirmed: 3, stale: 1, unconfirmed: 2 } };
    state.status = 'error';
    render(<ResourcePanel />);
    expect(screen.getByText('Models').nextElementSibling).toHaveTextContent(/^unknown/);
    expect(screen.getByText('Local models').nextElementSibling).toHaveTextContent('2');
  });
});
