/**
 * red-desk-fix-c216.test.tsx — RQ-PHX-REDDESKFIXC216 spec test for the
 * RQ-SWE3-BOARDUI-1 recut (PR #4957, itself carrying #4941/#4084).
 *
 * The PR's only real failing check was Quick typecheck's hermetic authority
 * shard: `test/authority-tier1-closure-310b.test.ts` reported the Tier-1
 * import closure grown by exactly `src/core/fleet/fleet-board-read.ts`, and
 * the blessed snapshot lives under test/fixtures/authority/** (CODEOWNERS),
 * so the drift could never be approved from this lane. The fix folds the
 * reader — same exports, same bounded readSource() — into
 * `core/fleet/leader-journal.ts`, which is already a closure member, so the
 * snapshot is byte-identical.
 *
 * These tests pin that fix: the board contract is imported from
 * `core/fleet/leader-journal.js` (a separate module file would re-grow the
 * closure), and the pane still renders the recorded board end-to-end —
 * lanes, tier depth, the needs-Mason item, 'unknown' never collapsing to 0,
 * and a missing recording as the designed empty state.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../data/cache.js';
import type { PaneProps } from './panes/pane-registry.js';
import type { FleetBoardResponse } from '../../data/api-types.js';
import {
  fleetBoardPath,
  fleetBoardResponse,
  readFleetBoard,
} from '../../../core/fleet/leader-journal.js';
import { FleetBoardPane } from './fleet-board/FleetBoardPane.js';

const BOARD: NonNullable<FleetBoardResponse['board']> = {
  schema: 'fleet.leader-board.v1',
  generatedAt: '2026-11-09T12:00:00.000Z',
  lanes: [
    { lane: 'devin', ready: 3, parked: 1, running: 2, mergesLastHour: 4, oldestWaitSeconds: 540 },
    { lane: 'claude', ready: 0, parked: 0, running: 1, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: { frontier: 2, work: 5, mid: 1 },
  mergesLastHour: 7,
  conflictingPrs: { count: 2, delta: 1, trend: 'rising', history: [] },
  needsMason: { status: 'available', count: 1, items: [{ id: 'nm-fake0001', text: 'approve the staging deploy' }] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

const PROPS = { visible: true } as PaneProps;

async function withRunsDir(boardText: string | null, fn: (runsDir: string) => Promise<void>): Promise<void> {
  const runsDir = await mkdtemp(join(tmpdir(), 'red-desk-fix-c216-'));
  try {
    if (boardText !== null) {
      await mkdir(join(runsDir, 'coordination'), { recursive: true });
      await writeFile(fleetBoardPath(runsDir), boardText);
    }
    await fn(runsDir);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('serves the recorded board from the in-closure leader-journal module and renders it', async () => {
  await withRunsDir(JSON.stringify(BOARD), async (runsDir) => {
    // The exact calls api.ts's GET /api/fleet/board makes — imported from
    // leader-journal.js, pinning the fold that keeps the Tier-1 closure flat.
    const read = await readFleetBoard({ runsDir });
    expect(read).toMatchObject({ status: 'ok', board: { generatedAt: BOARD.generatedAt } });
    const envelope = fleetBoardResponse(read, Date.parse('2026-11-09T12:02:30Z'));
    expect(envelope).toMatchObject({ schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 150 });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/fleet/board');
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FleetBoardPane {...PROPS} />);

    await waitFor(() => expect(screen.getByText('devin')).toBeInTheDocument());
    expect(screen.getByText('Fleet Board')).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('approve the staging deploy')).toBeInTheDocument();
    // claude's unmeasured mergesLastHour prints 'unknown', never 0.
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('keeps a missing recording honest: status missing, null board, designed empty state', async () => {
  await withRunsDir(null, async (runsDir) => {
    const read = await readFleetBoard({ runsDir });
    expect(read).toEqual({ status: 'missing', board: null });
    const envelope = fleetBoardResponse(read, Date.now());
    expect(envelope).toMatchObject({ status: 'missing', ageSeconds: null, board: null });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 })));
    render(<FleetBoardPane {...PROPS} />);

    await waitFor(() => expect(screen.getByText('No Leader board yet')).toBeInTheDocument());
    expect(screen.queryByText('Queue depth by tier')).not.toBeInTheDocument();
  });
});
