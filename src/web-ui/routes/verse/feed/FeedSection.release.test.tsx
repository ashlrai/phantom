import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { activitySnapshot } from '../command/fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { FeedSection } from './FeedSection.js';

beforeEach(() => { evictAll(); resetActivityForTest(async () => activitySnapshot('live', Date.now())); });
afterEach(() => { resetActivityForTest(); vi.unstubAllGlobals(); });
it('renders incomplete release assets as an alert', async () => {
  stubSurfaceFetch({ routes: { '/api/verse/release/stages': { schema: 'verse.release-stages.v1', tag: 'v3.30.8', checkedAt: new Date().toISOString(), stages: [{ stage: 'published', status: 'unknown', reason: 'desktop asset evidence incomplete; retry; missing or invalid: latest.json' }] } } });
  render(<FeedSection />);
  const title = await screen.findByText('v3.30.8 is public; required desktop assets are missing or invalid.');
  expect(title.closest('li')).toHaveAttribute('data-kind', 'alert');
});
