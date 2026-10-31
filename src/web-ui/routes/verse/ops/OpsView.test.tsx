/**
 * Smoke test: the Ops section mounts, its five views are reachable through
 * the segmented switch, and each renders its fixture bus projection. This is
 * the whole-surface check the task asks for: one render exercising Board,
 * Fleet & router, Releases and Leaders against fixture bus data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../../data/cache.js';
import { OpsView } from './OpsView.js';
import {
  VERSE_OPS_BOARD_PATH,
  VERSE_OPS_FLEET_PATH,
  VERSE_OPS_LEADERS_PATH,
  VERSE_OPS_RELEASES_PATH,
  type OpsBoardV1,
  type OpsFleetV1,
  type OpsLeadersV1,
  type OpsReleasesV1,
} from '../../../../core/verse/ops-types.js';

const board: OpsBoardV1 = {
  v: 1, generatedAt: '2026-10-30T10:05:00Z', team: 'default',
  columns: {
    next: [], held: [], done: [], closed: [],
    active: [{
      id: 'fleet:t1', source: 'fleet', title: 'Board-visible task', repo: 'ashlrai/phantom',
      column: 'active', assignee: 'seat-claude-1', estimate: 'low', outcome: null,
      needsYou: false, updatedAt: '2026-10-30T10:00:00Z',
    }],
  },
  counts: { next: 0, active: 1, held: 0, done: 0, closed: 0 },
  sources: { fleet: 'healthy', handoff: 'healthy', companion: 'healthy' },
};

const fleet: OpsFleetV1 = {
  v: 1, generatedAt: '2026-10-30T10:05:00Z', tickAt: '2026-10-30T10:04:00Z',
  lanes: [{ lane: 'codex', slots: 1, busy: 1, capReason: null }],
  holdProduction: null, held: [], decisions: [], experiments: [],
  sources: { tick: 'healthy', journal: 'healthy', learning: 'healthy' },
};

const releases: OpsReleasesV1 = {
  v: 1, generatedAt: '2026-10-30T10:05:00Z', sourceState: 'healthy',
  repos: [{ repo: 'ashlrai/phantom', path: '/repos/phantom', version: '3.16.2', latestTag: 'v3.16.2', releaseWorkflow: 'release.yml', gh: null, notes: [] }],
};

const leaders: OpsLeadersV1 = {
  v: 1, generatedAt: '2026-10-30T10:05:00Z', team: 'default', channel: 'leaders',
  leaders: [{ id: 'human:mason', kind: 'human', role: 'owner', provider: null, onBehalfOf: null, capabilities: [], online: true, lastSeenAt: '2026-10-30T10:00:00Z', leader: true }],
  channels: [{ channel: 'leaders', count: 1 }],
  messages: [{ id: 'm1', from: 'human:mason', at: '2026-10-30T09:00:00Z', text: 'Channel reachable from the smoke test.' }],
  openHandoffs: [], pendingApprovals: [], canPost: false,
};

function stubAll() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === VERSE_OPS_BOARD_PATH) return Response.json(board);
    if (path === VERSE_OPS_FLEET_PATH) return Response.json(fleet);
    if (path === VERSE_OPS_RELEASES_PATH) return Response.json(releases);
    if (path === VERSE_OPS_LEADERS_PATH) return Response.json(leaders);
    return Response.json({ error: 'not found' }, { status: 404 });
  }));
}

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Ops section smoke', () => {
  it('serves all five command-center views through the segmented switch', async () => {
    stubAll();
    const user = userEvent.setup();
    render(<OpsView />);

    expect(screen.getByRole('radio', { name: 'Live runs' })).toBeChecked();
    expect(await screen.findByText('Live runs are not in this build yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Board' }));
    expect(await screen.findByText('Board-visible task')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Fleet & router' }));
    expect(await screen.findByText('codex')).toBeInTheDocument();
    expect(screen.getByText('1 busy · 1 slot')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Releases' }));
    expect(await screen.findByText('ashlrai/phantom')).toBeInTheDocument();
    expect(screen.getByText('tag v3.16.2')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Leaders' }));
    expect(await screen.findByText('Channel reachable from the smoke test.')).toBeInTheDocument();
    expect(screen.getAllByText('human:mason').length).toBeGreaterThan(0);

    // And back to the board, still intact.
    await user.click(screen.getByRole('radio', { name: 'Board' }));
    expect(await screen.findByText('Board-visible task')).toBeInTheDocument();
  });
});
