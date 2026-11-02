import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';
import { WorkersSection } from './WorkersSection.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('fleet worker age indicators', () => {
  it('shows the stuck badge and count while keeping normal workers unflagged', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { workers: [
      { job: 'RQ-FAKE-STUCK', lane: 'codex-personal', tier: 'work', ageSeconds: 3 * 60 * 60 },
      { job: 'RQ-FAKE-NORMAL', lane: 'codex-personal', tier: 'work', ageSeconds: 5 * 60 },
    ] } });
    renderMobile(<WorkersSection />);

    const section = await screen.findByRole('region', { name: 'Fleet workers' });
    expect(within(section).getByText(/1 look stuck/)).toBeInTheDocument();
    expect(within(section).getAllByText('stuck')).toHaveLength(1);
    expect(within(screen.getByRole('button', { name: /Open worker RQ-FAKE-STUCK/ })).getByText('stuck')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Open worker RQ-FAKE-NORMAL' })).queryByText('stuck')).not.toBeInTheDocument();
  });

  it('shows a long badge without a stuck count', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { workers: [
      { job: 'RQ-FAKE-LONG', lane: 'codex-personal', tier: 'work', ageSeconds: 31 * 60 },
    ] } });
    renderMobile(<WorkersSection />);

    expect(await screen.findByText('long')).toBeInTheDocument();
    expect(screen.queryByText(/look stuck/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Long for this lane/ })).toBeInTheDocument();
  });
});
