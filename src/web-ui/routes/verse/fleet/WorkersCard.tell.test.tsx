import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { openInterjectDialog } from './interject-dialog-store.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import { WorkersCard } from './WorkersCard.js';

vi.mock('./interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));
vi.mock('./JobDetailSheet.js', () => ({ JobDetailSheet: vi.fn(() => null) }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('offers a prefilled interjection only for a stuck worker without opening its sheet', async () => {
  const workers = [
    { job: 'personal-stuck', lane: 'codex-personal', ageSeconds: 70 * 60 },
    { job: 'personal-fresh', lane: 'codex-personal', ageSeconds: 10 * 60 },
  ].map(worker => ({ ...worker, repo: 'example/repo', tier: 'mid' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, generatedAt: 'now',
    sources: { workers: 'healthy' }, workers, publishesLastHour: [] })));
  const onParentClick = vi.fn();
  render(<div onClick={onParentClick}><SectionVisibilityProvider visible><WorkersCard /></SectionVisibilityProvider></div>);
  const table = await screen.findByRole('table');
  const row = (job: string) => within(table).getByRole('button', { name: `Job ${job}` }).closest('tr')!;
  fireEvent.click(within(row('personal-stuck')).getByRole('button', { name: 'Tell the leaders about personal-stuck' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re personal-stuck (codex-personal, example/repo): running 1:10 with no PR, looks stuck. ' });
  expect(onParentClick).not.toHaveBeenCalled();
  expect(JobDetailSheet).not.toHaveBeenCalled();
  expect(within(row('personal-fresh')).queryByRole('button', { name: /Tell the leaders/ })).not.toBeInTheDocument();
});
