import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MachineCard } from './MachineCard.js';
import { useQuery } from '../../../data/hooks.js';

vi.mock('../../../data/hooks.js', () => ({ useQuery: vi.fn() }));
const mocked = vi.mocked(useQuery);
describe('Machine card', () => {
  it('shows normal measurements', () => {
    mocked.mockReturnValue({ data: { load1: 18, cpus: 18, loadPerCpu: 1, swapGb: 2, diskFreeGb: 100, worktrees: 3, runningWorkers: 4, overloaded: false }, status: 'success' } as never);
    render(<MachineCard />);
    expect(screen.getByText('100 GB')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('warns when overloaded', () => {
    mocked.mockReturnValue({ data: { load1: 204, cpus: 18, loadPerCpu: 204 / 18, overloaded: true }, status: 'success' } as never);
    render(<MachineCard />);
    expect(screen.getByRole('alert').textContent).toContain('over 4 times');
  });
  it('shows unknown for missing measurements', () => {
    mocked.mockReturnValue({ data: undefined, status: 'error' } as never);
    render(<MachineCard />);
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(4);
  });
});
