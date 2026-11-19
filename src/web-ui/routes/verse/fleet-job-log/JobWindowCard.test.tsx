import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type MockInstance, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { buildJobWindow, type JobWindowFacts } from '../../../../core/fleet/job-window.js';
import { JobWindowCard } from './JobWindowCard.js';
import type { FleetJobDetailV1 } from './worker-log-model.js';

const pr = 'https://github.com/example/repo/pull/7';
let spy: MockInstance<typeof client.apiGet>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); evictAll(); });
function serve(facts: Partial<JobWindowFacts>) {
  const value = buildJobWindow({ job: 'RQ-ONE', ...facts });
  spy = vi.spyOn(client, 'apiGet').mockResolvedValue(value);
}
const fact = (label: string) => within(screen.getByRole('region', { name: 'Job window' })).getByText(label).nextElementSibling;

it('shows a running job', async () => {
  serve({ detailState: 'running', lane: 'fast', model: 'small', repo: 'example/repo', tier: 'mid', startedAt: '2026-11-01T00:00:00Z' });
  render(<JobWindowCard job="RQ-ONE" enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Running now.');
  expect(fact('Lane')).toHaveTextContent('fast');
  expect(fact('Model')).toHaveTextContent('small');
  expect(fact('Repo')).toHaveTextContent('example/repo');
  expect(fact('Tier')).toHaveTextContent('mid');
  expect(fact('Started')).toHaveTextContent('2026-11-01T00:00:00Z');
  expect(fact('Finished')).toHaveTextContent('not yet');
  expect(fact('Pull request')).toHaveTextContent('not yet');
  expect(spy).toHaveBeenCalledWith('/api/fleet/job/window?id=RQ-ONE&lines=1', undefined);
});

it('shows a finished job with its pull request as a link', async () => {
  serve({ detailState: 'published', prUrl: pr, finishedAt: '2026-11-01T01:00:00Z' });
  render(<JobWindowCard job="RQ-ONE" enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Finished with a pull request.');
  const link = within(fact('Pull request') as HTMLElement).getByRole('link', { name: pr });
  expect(link).toHaveAttribute('href', pr);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(fact('Finished')).toHaveTextContent('2026-11-01T01:00:00Z');
});

it('shows a job with nothing to ship and why', async () => {
  serve({ detailState: 'published', resultEmpty: true });
  render(<JobWindowCard job="RQ-ONE" enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Finished with nothing to ship.');
  expect(screen.getByText('The worker reported no change to publish.')).toBeInTheDocument();
  expect(fact('Pull request')).toHaveTextContent('none');
});

it('shows a stopped job and who stopped it', async () => {
  serve({ detailState: 'running', stop: { at: '2026-11-01T02:00:00Z', by: 'owner' } });
  render(<JobWindowCard job="RQ-ONE" enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Stopped before it finished.');
  expect(screen.getByText('Stopped by owner at 2026-11-01T02:00:00Z.')).toBeInTheDocument();
  expect(fact('Finished')).toHaveTextContent('2026-11-01T02:00:00Z');
});

it('says unknown for a job with no evidence', async () => {
  serve({});
  render(<JobWindowCard job="RQ-ONE" enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('State unknown.');
  for (const label of ['Lane', 'Model', 'Repo', 'Tier', 'Started', 'Finished']) expect(fact(label)).toHaveTextContent(/^unknown$/);
  expect(fact('Pull request')).toHaveTextContent('none');
  expect(screen.queryByRole('link')).toBeNull();
});

it.each([404, 403])('builds the window from the job detail when the route answers %s', async (status) => {
  spy = vi.spyOn(client, 'apiGet').mockRejectedValue(new client.ApiError('missing', status, '/api/fleet/job/window'));
  const detail: FleetJobDetailV1 = { schema: 'fleet.job.v1', state: 'published', lane: 'slow', model: 'large', tier: 'top', launchedAt: '2026-11-01T00:00:00Z', publish: { prUrl: pr } };
  render(<JobWindowCard job="RQ-ONE" detail={detail} enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Finished with a pull request.');
  expect(fact('Lane')).toHaveTextContent('slow');
  expect(fact('Model')).toHaveTextContent('large');
  expect(fact('Tier')).toHaveTextContent('top');
  expect(fact('Started')).toHaveTextContent('2026-11-01T00:00:00Z');
  expect(fact('Repo')).toHaveTextContent(/^unknown$/);
  expect(fact('Finished')).toHaveTextContent(/^unknown$/);
  expect(screen.getByRole('link', { name: pr })).toHaveAttribute('href', pr);
});

it('falls back to the job detail when the route answers an unexpected shape', async () => {
  spy = vi.spyOn(client, 'apiGet').mockResolvedValue({ schema: 'fleet.job.v1' });
  render(<JobWindowCard job="RQ-ONE" detail={{ schema: 'fleet.job.v1', state: 'running', lane: 'fast' }} enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Running now.');
  expect(fact('Lane')).toHaveTextContent('fast');
});

it('drops a PR link that is not http(s)', async () => {
  spy = vi.spyOn(client, 'apiGet').mockResolvedValue({ ...buildJobWindow({ job: 'RQ-ONE', detailState: 'published', prUrl: pr }), prUrl: 'javascript:alert(1)' });
  render(<JobWindowCard job="RQ-ONE" enabled />);
  expect(await screen.findByRole('status')).toHaveTextContent('Finished with a pull request.');
  expect(screen.queryByRole('link')).toBeNull();
});

it('does not fetch while disabled', async () => {
  spy = vi.spyOn(client, 'apiGet');
  render(<JobWindowCard job="RQ-ONE" enabled={false} />);
  expect(spy).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Job window' })).toBeNull();
});

// jsdom does no layout, so the phone fit is checked in the stylesheet itself.
it('lays the facts out in one column on a phone and wraps long values', () => {
  const css = readFileSync(resolve('src/web-ui/routes/verse/fleet-job-log/job-window-card.module.css'), 'utf8');
  expect(css).toMatch(/@media \(max-width: 480px\)\s*\{\s*\.facts \{ grid-template-columns: 1fr; \}/);
  expect(css).toMatch(/\.fact dd \{[^}]*overflow-wrap: anywhere/);
});
