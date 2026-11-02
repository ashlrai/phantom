import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';
import { WorkersSection } from './WorkersSection.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('WorkersSection show-all', () => {
  it('caps workers at 20 and expands with a working Show all button', async () => {
    const workers = Array.from({ length: 23 }, (_, i) => ({
      job: `RQ-FAKE-${i}`, lane: 'fake-lane', tier: 'work', ageSeconds: i * 200, repo: 'private-repo-fixture',
    }));
    stubFetch({ 'GET /api/verse/fleet/runs': { workers } });
    renderMobile(<WorkersSection />);

    const toggle = await screen.findByRole('button', { name: 'Show all 23 workers' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { name: /^Open worker / })).toHaveLength(20);
    expect(screen.queryByText('RQ-FAKE-0')).not.toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+ more$/)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getAllByRole('button', { name: /^Open worker / })).toHaveLength(23);
    expect(screen.getByText('RQ-FAKE-0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText(/^\+\d+ more$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('button', { name: /^Open worker / })).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'Show all 23 workers' })).toHaveAttribute('aria-expanded', 'false');
  });
});
