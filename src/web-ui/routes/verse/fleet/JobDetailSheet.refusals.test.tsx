import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { JobDetailSheet } from './JobDetailSheet.js';

vi.mock('../../../data/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(),
}));

const job = 'RQ-PHX-FOO';
const detail = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex-personal',
  publish: { prUrl: 'https://github.com/example/repo/pull/12' }, log: { source: 'live', tail: ['Log line'] },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const changes = { schema: 'fleet.job.changes.v1', generatedAt: '2026-10-31T12:00:00Z', job, state: 'live',
  baseSha: 'abcdef123456', files: [
    { path: 'CHANGELOG.md', status: 'modified', added: 3, removed: 0 },
    { path: 'package-lock.json', status: 'modified', added: 40, removed: 40 },
    { path: 'src/ok.ts', status: 'modified', added: 5, removed: 1 },
  ], totals: { files: 3, added: 48, removed: 41 }, truncated: false,
  refusals: [
    { path: 'CHANGELOG.md', rule: 'changelog-singleton' },
    { path: 'package-lock.json', rule: 'lockfile' },
  ] };

beforeEach(() => {
  evictAll();
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? changes : detail);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); evictAll(); });

it('shows a warn chip naming the files that will collide at merge time', async () => {
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Changed files' });
  const chip = await within(section).findByText(/Will collide:/);
  expect(chip).toHaveTextContent('Will collide: CHANGELOG.md (changelog singleton), package-lock.json (lockfile)');
});

it('omits the chip when the job touches no refused files', async () => {
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? { ...changes, refusals: [] } : detail);
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Changed files' });
  expect(await within(section).findByText(/Changes · 3 files/)).toBeInTheDocument();
  expect(within(section).queryByText(/Will collide/)).not.toBeInTheDocument();
});

it('omits the chip for a build whose response does not carry refusals', async () => {
  const { refusals: _omitted, ...legacy } = changes;
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? legacy : detail);
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Changed files' });
  expect(await within(section).findByText(/Changes · 3 files/)).toBeInTheDocument();
  expect(within(section).queryByText(/Will collide/)).not.toBeInTheDocument();
});
