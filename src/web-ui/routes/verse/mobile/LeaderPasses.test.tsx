import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { LeaderPasses } from './LeaderPasses.js';

const fixture = () => ({ generatedAt: new Date().toISOString(), sources: { workers: 'healthy', runsDir: 'healthy' },
  leaders: [{ label: 'opus-leader', ageSeconds: 240 }, { label: 'sol-leader', ageSeconds: 60 }],
  orchestratorAgents: 3, lastTick: new Date(Date.now() - 120_000).toISOString(), paused: false, claudeLane: 'healthy' });
beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the live passes and dispatcher state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<LeaderPasses />);
  const card = await screen.findByRole('region', { name: 'Leader passes on the Mac' });
  expect(await within(card).findByText('Leaders active')).toBeInTheDocument();
  expect(within(card).getByText('opus-leader').parentElement?.parentElement).toHaveTextContent(/4m 0\ds/);
  expect(within(card).getByText('sol-leader').parentElement?.parentElement).toHaveTextContent(/1m 0\ds/);
  expect(card).toHaveTextContent('3 agents');
  expect(card).toHaveTextContent('2 min ago');
  expect(card).toHaveTextContent('healthy');
});

it('shows degraded and paused states and keeps lane diagnostics private', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture(), sources: { workers: 'degraded', runsDir: 'healthy' }, leaders: [], paused: true, claudeLane: 'down token rejected 2026-10-31 01:03' })));
  render(<LeaderPasses />);
  expect(await screen.findByText('Paused')).toBeInTheDocument();
  expect(screen.getByText('Claude lane down')).toBeInTheDocument();
  expect(screen.getByText(/Some live run sources/)).toBeInTheDocument();
  expect(screen.queryByText(/token rejected/)).not.toBeInTheDocument();
});

it('shows an unknown headline when workers are degraded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture(), sources: { workers: 'degraded', runsDir: 'healthy' }, leaders: [] })));
  render(<LeaderPasses />);
  expect(await screen.findByText(/Some live run sources/)).toBeInTheDocument();
  expect(screen.getByText('—')).toBeInTheDocument();
  expect(screen.queryByText(/Leaders quiet/)).not.toBeInTheDocument();
});

it('explains a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<LeaderPasses />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});

it('polls every 15 seconds only while the section is visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const { rerender } = render(<SectionVisibilityProvider visible><LeaderPasses /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rerender(<SectionVisibilityProvider visible={false}><LeaderPasses /></SectionVisibilityProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rerender(<SectionVisibilityProvider visible><LeaderPasses /></SectionVisibilityProvider>);
  await act(async () => {});
  expect(fetcher).toHaveBeenCalledTimes(3);
});
