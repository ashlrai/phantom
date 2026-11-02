import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';
import { CI_NOW, ciFacts } from './ci-needs-you.test-support.js';
import { CI_PLAN_COMMAND } from './ci-needs-you.js';
import { buildPaletteItems } from './palette-model.js';

beforeEach(() => { localStorage.clear(); evictAll(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });
function setup(response: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/verse/fleet/ci-runs?hours=24'
    ? response() : new Response('', { status: 404 })));
  const reports: FleetNeedsYouReport[] = [];
  render(<FleetNeedsYouRows split="all" nowMs={CI_NOW} onResult={report => reports.push(report)} />);
  return reports;
}

it('renders one warning, reports it for the drawer count and copies the exact command', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const reports = setup(() => Response.json(ciFacts));
  expect(await screen.findByText("CI ran 10 times on PRs today; Mason's order is once a day")).toBeInTheDocument();
  expect(screen.getByText(/4 reds: 2 rebase artifacts/)).toBeInTheDocument();
  await waitFor(() => expect(reports.at(-1)?.items.map(item => item.id)).toEqual(['ci-runs-on-prs']));
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
  await screen.findByRole('button', { name: 'Copy command · copied' });
  expect(writeText).toHaveBeenCalledWith(CI_PLAN_COMMAND);
  const items = buildPaletteItems({ needsYou: [], fleetNeedsYou: reports.at(-1)!.items, running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
  expect(items.filter(item => item.group === 'needs-you')).toHaveLength(1);
});

it('offers manual copying when clipboard access fails', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  setup(() => Response.json(ciFacts));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
  expect(await screen.findByText(`Copy command: ${CI_PLAN_COMMAND}`)).toBeVisible();
});

it('renders no CI row or error on a 404 or a network failure', async () => {
  const reports = setup(() => new Response('', { status: 404 }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/ci-runs?hours=24', expect.anything()));
  await waitFor(() => expect(reports.at(-1)).toMatchObject({ items: [], silent: null }));
  expect(screen.queryByRole('region', { name: 'Fleet on this Mac' })).not.toBeInTheDocument();
  await refetchQuery('verse-fleet-ci-runs-24', async () => { throw new Error('offline'); }, true);
  expect(screen.queryByText(/CI ran/)).not.toBeInTheDocument();
});
