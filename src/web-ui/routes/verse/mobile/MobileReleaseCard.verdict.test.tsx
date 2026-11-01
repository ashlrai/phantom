import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { MobileReleaseCard } from './MobileReleaseCard.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

const pr = {
  number: 1479, title: 'chore(master): release 3.29.16', url: 'https://github.com/example/phantom/pull/1479', version: '3.29.16',
  openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: 'UNKNOWN',
  checks: [], failing: [], pending: 0, blocked: false, summary: '3.29.16 green, waiting for merge',
};

function release(entry: Record<string, unknown> = {}, prOverrides: Partial<typeof pr> = {}) {
  return {
    v: 1, generatedAt: '2026-11-01T12:00:00Z', sourceState: 'healthy',
    repos: [{ repo: 'example/phantom', path: '/fixture/phantom', pr: { ...pr, ...prOverrides }, notes: [], ...entry }],
  };
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows the reported downgrade with attention and no merge control', async () => {
  stubFetch({ 'GET /api/verse/release-pr': release({ treeVersion: '3.30.0', versionVerdict: 'downgrade' }) });
  renderMobile(<MobileReleaseCard />);
  const line = await screen.findByText('Would ship 3.29.16, tree targets 3.30.0 · blocked');
  expect(line.parentElement).toHaveAttribute('data-tone', 'warning');
  expect(screen.queryByText(/ready to merge/)).not.toBeInTheDocument();
  expect(screen.queryByText(/green, waiting for merge/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /merge/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', pr.url);
});

it('shows the existing ready line when the fields are absent', async () => {
  stubFetch({ 'GET /api/verse/release-pr': release() });
  renderMobile(<MobileReleaseCard />);
  expect(await screen.findByText('v3.29.16 candidate · PR #1479 · ready to merge')).toBeInTheDocument();
  expect(screen.getByText('3.29.16 green, waiting for merge')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', pr.url);
});

it('computes a downgrade when only the tree version is present', async () => {
  stubFetch({ 'GET /api/verse/release-pr': release({ treeVersion: '3.30.0' }) });
  renderMobile(<MobileReleaseCard />);
  expect(await screen.findByText('Would ship 3.29.16, tree targets 3.30.0 · blocked')).toBeInTheDocument();
});

it.each([
  [{ blocked: true, failing: ['build'] }, 'v3.29.16 candidate · PR #1479 · blocked: build'],
  [{ pending: 2 }, 'v3.29.16 candidate · PR #1479 · 2 checks pending'],
])('preserves an existing blocked or waiting state', async (overrides, text) => {
  stubFetch({ 'GET /api/verse/release-pr': release({ treeVersion: '3.30.0', versionVerdict: 'downgrade' }, overrides) });
  renderMobile(<MobileReleaseCard />);
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(screen.queryByText(/Would ship/)).not.toBeInTheDocument();
});
