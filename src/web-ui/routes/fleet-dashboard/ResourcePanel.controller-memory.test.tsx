import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourcePanel } from './ResourcePanel.js';

const model = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: model.data }),
  useRefetch: () => () => {}, useRefresh: () => () => {},
}));
describe('controller memory advisory', () => {
  afterEach(() => vi.useRealTimers());
  it('labels the pressure reading separately from physical memory and admission', () => {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
    model.data = { pools: [], machine: { memFreePct: null, swapUsedPct: null, diskFreePct: null, admission: 'unknown' },
      localModels: { count: null }, controllerMemory: { pressureFreePct: 46, observedAt: '2026-11-06T12:00:00.000Z' } };
    render(<ResourcePanel />);
    expect(screen.getByText('macOS memory availability')).toBeInTheDocument();
    expect(screen.getByText('46.0%')).toBeInTheDocument();
    expect(screen.getByText(/Memory pressure reading/)).toBeInTheDocument();
    expect(screen.getByText('Memory free').nextElementSibling).toHaveTextContent('unknown');
    expect(screen.getByText('Machine admission').nextElementSibling).toHaveTextContent('unknown');
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('macOS memory availability').nextElementSibling).toHaveTextContent('unknown');
  });
});
