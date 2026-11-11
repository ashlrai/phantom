import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { ApiError } from '../../../data/client.js';
import { BudgetControl } from './BudgetControl.js';
import { updateBudget } from './budget-queries.js';

vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: currentView, status: 'success' }), useRefetch: () => () => {} }));
vi.mock('./budget-queries.js', () => ({ budgetQuery: {}, budgetPreviewQuery: {}, updateBudget: vi.fn() }));
let currentView: BudgetView;
function fixture(count = 2): BudgetView {
  const ids = ['claude-fake', 'codex-fake', 'grok-fake'];
  return {
    mode: 'balanced', seats: {}, updatedAt: '', sampledAt: '', readingMaxAgeMs: 1000, headroom: [],
    seatInfo: ids.map((seatId, i) => ({ seatId, label: ['Claude', 'Codex', 'Grok'][i]!, engine: ['claude', 'codex', 'grok'][i] as 'claude' | 'codex' | 'grok', free: false })),
    effective: Object.fromEntries(ids.map((seatId, i) => [seatId, { seatId, enabled: true, reservePercent: i < count ? 40 : 0, maxSessionWindowPercent: i < count ? 70 : null }])),
  };
}
afterEach(() => { clearMutationToken(); vi.clearAllMocks(); });

describe('remove reserves', () => {
  it('clears each seat in order', async () => {
    currentView = fixture(); setMutationToken('fake-token');
    vi.mocked(updateBudget).mockResolvedValue(currentView);
    render(<BudgetControl />);
    expect(screen.getByText(/2 seats keep usage back for you \(Claude 40%, Codex 40%\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use 100%' }));
    await waitFor(() => expect(updateBudget).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateBudget).mock.calls.map(([arg]) => arg)).toEqual(['claude-fake', 'codex-fake'].map((seatId) => ({ seatId, policy: { reservePercent: 0, maxSessionWindowPercent: null } })));
  });
  it('stops at a failure and displays the seat and server reason', async () => {
    currentView = fixture(3); setMutationToken('fake-token');
    vi.mocked(updateBudget).mockResolvedValueOnce(currentView).mockRejectedValueOnce(new ApiError('conflict', 409, '/budget', 'Seat is busy'));
    render(<BudgetControl />); fireEvent.click(screen.getByRole('button', { name: 'Use 100%' }));
    expect(await screen.findByText(/codex-fake.*Seat is busy/)).toBeInTheDocument();
    expect(updateBudget).toHaveBeenCalledTimes(2);
  });
  it('hides the banner when no seat has a reserve', () => {
    currentView = fixture(0); render(<BudgetControl />);
    expect(screen.queryByRole('button', { name: 'Use 100%' })).not.toBeInTheDocument();
  });
});
