import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { authorityStatus, budgetView, fleetLive } from '../../command/fixtures.test-support.js';
import { decisionsView, wouldMergeDecision } from '../../command/ladder-fixtures.test-support.js';
import { controlSnapshot } from '../../sections/section-fixtures.test-support.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { FleetScreen } from './FleetScreen.js';

const NOW = Date.now();

function mount(ledger: unknown = decisionsView(NOW, { decisions: [
  wouldMergeDecision(NOW, { repo: 'ashlrai/phantom', prNumber: 1938 }),
  wouldMergeDecision(NOW, { proposalId: 'short', repo: 'short', prNumber: 12 }),
  wouldMergeDecision(NOW, { proposalId: 'no-pr', repo: 'ashlrai/other', prNumber: null }),
] })) {
  stubFetch({
    'GET /api/verse/control': controlSnapshot(),
    'GET /api/verse/fleet/live': fleetLive('live', NOW),
    'GET /api/verse/authority': authorityStatus('live', NOW),
    'GET /api/verse/budget': budgetView('live', NOW),
    'GET /api/verse/authority/ledger': ledger,
  });
  return renderMobile(<FleetScreen />);
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('FleetScreen links', () => {
  it('links decisions only when a complete PR URL can be built', async () => {
    mount();
    const link = (await screen.findByText('phantom #1938')).closest('a');
    expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1938');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(screen.getByText('short #12').closest('a')).toBeNull();
    expect(screen.getByText('other').closest('a')).toBeNull();
  });

  it('links finished runs when the ledger is unavailable', async () => {
    mount(json({ error: 'nope' }, 404));
    const link = (await screen.findByText('Inline the score cache')).closest('a');
    expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/measurably/pull/19');
    expect(screen.getByText('Rename internal helpers').closest('a')).toBeNull();
  });

  it('opens Live runs when a lane is pressed', async () => {
    const { context } = mount();
    const lanes = await screen.findByLabelText('Lanes');
    fireEvent.click(within(lanes).getByRole('button', { name: /Local/ }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'runs' });
  });
});
