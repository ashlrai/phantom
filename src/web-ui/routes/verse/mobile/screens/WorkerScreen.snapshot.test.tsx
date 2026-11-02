import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { apiGet, ApiError } from '../../../../data/client.js';
import { renderMobile } from '../mobile.test-support.js';
import { WorkerScreen } from './WorkerScreen.js';

vi.mock('../ui.module.css', () => ({ default: { muted: 'test-muted' } }));

vi.mock('../../../../data/client.js', async (original) => ({
  ...await original<typeof import('../../../../data/client.js')>(), apiGet: vi.fn(),
}));

afterEach(() => { evictAll(); vi.resetAllMocks(); });

it('shows snapshot facts and a muted log note when the gateway denies detail', async () => {
  vi.mocked(apiGet).mockImplementation(async (path) => {
    if (path.startsWith('/api/fleet/job')) throw new ApiError('fake refusal', 403, path);
    return {
      v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], codexPersonal: null,
      mergesLastHour: { count: 0, items: [] },
      workers: [{ job: 'RQ-FAKE-31', repo: 'example/phantom', lane: 'fake-lane', tier: 'work', ageSeconds: 120 }],
      publishesLastHour: [{ job: 'RQ-FAKE-31', lane: 'fake-lane', url: 'https://github.com/example/phantom/pull/31', at: '2026-10-31T00:10:00Z' }],
    };
  });
  renderMobile(<WorkerScreen job="RQ-FAKE-31" />);
  const section = await screen.findByRole('region', { name: 'Worker (from the fleet snapshot)' });
  for (const [label, value] of [['Repo', 'example/phantom'], ['Lane', 'fake-lane'], ['Tier', 'work'], ['State', 'published']]) {
    expect(within(section).getByText(label).closest('div')).toHaveTextContent(value);
  }
  expect(within(section).getByRole('link', { name: 'PR #31' })).toHaveAttribute('href', 'https://github.com/example/phantom/pull/31');
  const note = screen.getByText('Worker logs are not available through this gateway yet. Open Phantom on your Mac.');
  expect(note).toHaveClass('test-muted');
  expect(note.closest('[role="alert"]')).toBeNull();
});
