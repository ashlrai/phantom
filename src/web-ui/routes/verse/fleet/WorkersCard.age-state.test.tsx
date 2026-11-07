import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { WorkersCard } from './WorkersCard.js';
import styles from './workers-card.module.css';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('marks workers by their lane thresholds and counts only stuck workers', async () => {
  const workers = [
    { job: 'personal-normal', lane: 'codex-personal', ageSeconds: 10 * 60 },
    { job: 'personal-long', lane: 'codex-personal', ageSeconds: 35 * 60 },
    { job: 'personal-stuck', lane: 'codex-personal', ageSeconds: 70 * 60 },
    { job: 'devin-normal', lane: 'devin', ageSeconds: 89 * 60 },
    { job: 'devin-long', lane: 'devin', ageSeconds: 100 * 60 },
  ].map(worker => ({ ...worker, repo: 'example/repo', tier: 'mid' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, generatedAt: 'now',
    sources: { workers: 'healthy' }, workers, publishesLastHour: [] })));
  render(<SectionVisibilityProvider visible><WorkersCard /></SectionVisibilityProvider>);
  const table = await screen.findByRole('table');
  const row = (job: string) => within(table).getByRole('button', { name: `Job ${job}` }).closest('tr')!;
  for (const job of ['personal-normal', 'devin-normal']) {
    expect(row(job).querySelector('[data-age-state]')).toHaveAttribute('data-age-state', 'normal');
    expect(within(row(job)).queryByText(/^(long|stuck\?)$/)).not.toBeInTheDocument();
  }
  expect(within(row('personal-long')).getByText('long')).toHaveAttribute('title', 'Long for this lane (over 30 min)');
  expect(row('personal-long')).toHaveClass(styles.rowLong);
  expect(within(row('devin-long')).getByText('long')).toHaveAttribute('title', 'Long for this lane (over 90 min)');
  expect(row('devin-long').querySelector('[data-age-state]')).toHaveAttribute('data-age-state', 'long');
  expect(within(row('personal-stuck')).getByText('stuck?')).toHaveAttribute('title', 'Likely stuck (over 60 min); open its log');
  expect(row('personal-stuck')).toHaveClass(styles.rowStuck);
  expect(row('personal-stuck').querySelector('[data-age-state]')).toHaveAttribute('data-age-state', 'stuck');
  expect(screen.getByText('5 workers running')).toBeInTheDocument();
  expect(screen.getByText('1 look stuck').tagName).toBe('SPAN');
});

it('omits the stuck count when no workers are stuck', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, generatedAt: 'now', sources: { workers: 'healthy' },
    workers: [{ job: 'devin-job', lane: 'devin', ageSeconds: 100 * 60, repo: 'repo', tier: 'mid' }], publishesLastHour: [] })));
  render(<SectionVisibilityProvider visible><WorkersCard /></SectionVisibilityProvider>);
  await screen.findByText('long');
  expect(screen.queryByText(/look stuck/)).not.toBeInTheDocument();
});
