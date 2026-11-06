import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { holdApprovalRepo } from '../fleet-actions.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { activityResponse, activityState, needsItem, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { NeedsYouScreen } from './NeedsYouScreen.js';

vi.mock('../fleet-actions.js', async (original) => ({
  ...await original<typeof import('../fleet-actions.js')>(), holdApprovalRepo: vi.fn(),
}));
beforeEach(() => { setMutationToken(TOKEN); stubFetch({}); });
afterEach(() => { clearMutationToken(); resetGuard(); evictAll(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const activity = activityState(activityResponse({ needsYou: [needsItem()] }));

it('confirms the repository-wide effect before persisting a hold and leaves approval pending', async () => {
  renderMobile(<><NeedsYouScreen /><MobileGuardSheet /></>, { activity });
  fireEvent.click(screen.getByRole('button', { name: 'Hold repo: ashlrai/ashlr-hub' }));
  expect(holdApprovalRepo).not.toHaveBeenCalled();
  expect(screen.getByText(/produce and merge nothing/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hold repo' }));
  await waitFor(() => expect(holdApprovalRepo).toHaveBeenCalledExactlyOnceWith('ashlrai/ashlr-hub'));
  expect(screen.getByRole('button', { name: /Approve:/ })).toBeInTheDocument();
});

it('disables a repo hold while offline', () => {
  renderMobile(<NeedsYouScreen />, { activity, reachability: 'offline' });
  expect(screen.getByRole('button', { name: 'Hold repo: ashlrai/ashlr-hub' })).toBeDisabled();
});

it('offers no repo hold on a read-only device', () => {
  renderMobile(<NeedsYouScreen />, { activity, permissions: permissionsFor('unavailable') });
  expect(screen.queryByRole('button', { name: /Hold repo:/ })).not.toBeInTheDocument();
});
