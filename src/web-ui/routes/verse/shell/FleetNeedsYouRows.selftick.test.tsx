import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fleet = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: 1, publishesLastHour: [], mergesLastHour: { count: 1, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const staleLast = {
  state: 'ok', at: new Date(now - 8_000_000).toISOString(), mode: 'apply',
  ranState: 'ran', ageSeconds: 8_000, failedSteps: [],
};
const freshLast = {
  state: 'ok', at: new Date(now).toISOString(), mode: 'apply',
  ranState: 'ran', ageSeconds: 0, failedSteps: [],
};
const ranReport = {
  v: 1, exitCode: 0,
  report: {
    v: 1, at: new Date(now).toISOString(), mode: 'apply', state: 'ran',
    steps: [
      { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
      { step: 'lane-autohold', state: 'ok', exitCode: 0, report: null },
      { step: 'planner-tick', state: 'ok', exitCode: 0, report: null },
    ],
  },
};

function setup() {
  let ran = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs') return Response.json(fleet);
    if (path === '/api/verse/fleet/self-tick' && init?.method === 'POST') {
      ran = true;
      return Response.json(ranReport);
    }
    if (path === '/api/verse/fleet/self-tick') {
      return Response.json({ v: 1, last: ran ? freshLast : staleLast });
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetNeedsYouRows split="fleet" nowMs={now} onResult={() => {}} />);
  return fetcher;
}

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { cleanup(); clearMutationToken(); evictAll(); vi.unstubAllGlobals(); });

it('runs self-tick from the stale row, confirms, and clears the row on a healthy refetch', async () => {
  setMutationToken('fake-mutation-token');
  const fetcher = setup();
  const user = userEvent.setup();
  const title = await screen.findByText(/Self-tick last ran .* ago/);
  await user.click(screen.getByRole('button', { name: 'Run self-tick now' }));
  expect(await screen.findByText('Self-tick ran, all steps ok')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText(/Self-tick last ran .* ago/)).not.toBeInTheDocument());
  expect(title).not.toBeInTheDocument();
  const posts = fetcher.mock.calls.filter(([path, init]) =>
    String(path) === '/api/verse/fleet/self-tick' && init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ apply: true });
  expect((posts[0]![1]!.headers as Record<string, string>)['x-ashlr-token']).toBe('fake-mutation-token');
  // The row's own GET ran at least twice: the poll that drew it and the refresh after the run.
  const gets = fetcher.mock.calls.filter(([path, init]) =>
    String(path) === '/api/verse/fleet/self-tick' && init?.method !== 'POST');
  expect(gets.length).toBeGreaterThanOrEqual(2);
});
