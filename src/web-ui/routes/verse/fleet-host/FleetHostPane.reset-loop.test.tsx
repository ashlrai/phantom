import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { VERSE_OPS_RESET_RELEASES_PATH } from '../../../../core/verse/ops-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHostPane } from './FleetHostPane.js';
import type { ResetReleases } from './reset-loop-query.js';

const now = Date.parse('2026-10-31T20:30:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const runs: FleetRuns = {
  v: 1, generatedAt: at(0), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: 2, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const releases: ResetReleases = { v: 1, generatedAt: at(0), loop: { started: true, lastRunAt: new Date(now - 40_000).toISOString(), lastResult: { at: at(0), checked: 1, released: [], errors: [] }, lastError: null }, releases: [{ v: 1, lane: 'codex-personal', state: 'reset-detected', usedPct: 0, readingAsOf: at(29), heldUntil: null, at: at(28), by: 'reset-detect', reason: 'reset' }] };
const resets = { v: 1, generatedAt: at(0), sourceState: 'healthy', rows: [{ lane: 'codex-personal', held: true, heldReason: 'usage', heldUntil: null, holdSince: at(60), heldBy: 'autobackoff', usedPct: 0, readingAsOf: at(25), resetAt: at(25), state: 'reset-detected', releasable: true, tell: '' }] };
function serve(loop: ResetReleases | null) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === VERSE_OPS_RESET_RELEASES_PATH) return loop ? Response.json(loop) : new Response(null, { status: 404 });
    if (url === '/api/verse/leader/resources/resets') return Response.json(resets);
    if (url === '/api/verse/fleet/runs') return Response.json(runs);
    return new Response(null, { status: 404 });
  }));
}
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); setMutationToken('fake-token'); });
afterEach(() => { clearMutationToken(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the loop, audit row, and an overdue reset incident', async () => {
  serve(releases); render(<FleetHostPane visible />);
  const section = await screen.findByRole('region', { name: 'Reset releases' });
  expect(await within(section).findByText('Reset loop armed · last run 40s ago · 0 released')).toHaveAttribute('data-tone', 'ok');
  expect(within(section).getByText(/codex-personal released .* \(reset detected, 0% used\)/)).toBeInTheDocument();
  expect(await within(section).findByRole('alert')).toHaveTextContent('Reset detected on codex-personal 25 min ago but the lane is still held');
});
it('marks an unarmed loop as bad with a mutation token', async () => {
  serve({ ...releases, loop: { ...releases.loop, started: false } }); render(<FleetHostPane visible />);
  expect(await screen.findByText('Reset loop not armed')).toHaveAttribute('data-tone', 'bad');
});
it('shows an unavailable message when the endpoint returns 404', async () => {
  serve(null); render(<FleetHostPane visible />);
  expect(await screen.findByText('Reset loop unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
