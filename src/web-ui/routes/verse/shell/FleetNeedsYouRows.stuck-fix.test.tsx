/**
 * FleetNeedsYouRows.stuck-fix — stuck guardian fix PRs surface as Needs-you
 * rows from GET /api/verse/runs-history/stuck-fixes; a build without the
 * route (404) adds nothing and shows no error.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const fleet = {
  v: 1, generatedAt: '2026-11-04T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-11-04T11:59:00Z', paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: 'down token rejected',
  lanes: [{ lane: 'claude', running: 0, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
  workers: [], leaders: [], orchestratorAgents: 1, publishesLastHour: [],
  mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const stuck = { v: 1, generatedAt: '2026-11-04T12:00:00Z', known: true, thresholdMinutes: 30, stuck: [
  { job: 'FIXUP-MAIN-9', repo: 'phantom', prUrl: 'https://github.com/ashlrai/phantom/pull/77', publishedAt: '2026-11-04T10:30:00Z', ageMinutes: 90 },
] };

function setup(stuckResponse: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs') return Response.json(fleet);
    if (path === '/api/verse/runs-history/stuck-fixes') return stuckResponse();
    return new Response('not found', { status: 404 });
  }));
  act(() => openVerseNeedsYou({ split: 'fleet' }));
  render(<FleetNeedsYouRows split="fleet" nowMs={NOW} onResult={() => {}} />);
}

beforeEach(() => { evictAll(); resetVerseUi(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders a row for a stuck fix PR', async () => {
  setup(() => Response.json(stuck));
  expect(await screen.findByText('phantom fix PR stuck 90 min', {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.getByText('FIXUP-MAIN-9 · #77')).toBeInTheDocument();
});

it('adds nothing and shows no error when the route is not in the build', async () => {
  setup(() => new Response('not found', { status: 404 }));
  // claude-lane-down keeps the group mounted so "loaded" is observable.
  expect(await screen.findByText(/Claude lane is down/, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.queryByText(/fix PR stuck/)).not.toBeInTheDocument();
  expect(screen.queryByText(/error|failed/i)).not.toBeInTheDocument();
});
