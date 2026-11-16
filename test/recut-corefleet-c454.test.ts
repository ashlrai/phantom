import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  conflictingPrIds,
  leaderBoardPath,
  queueDepthByTier,
  readLeaderBoard,
  recordLeaderBoard,
  readyRowsForDepth,
} from '../src/core/fleet/leader-board.js';
import { fleetBoardResponse, readFleetBoard } from '../src/core/fleet/leader-journal.js';

const NOW_MS = Date.parse('2026-11-15T12:00:00Z');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'recut-corefleet-c454-'));
  await mkdir(join(root, 'queue'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('writes the board atomically under coordination/ with owner-only modes and the API reader serves it', async () => {
  await writeFile(join(root, 'queue', 'ready.tsv'), [
    'READY\tRQ-FAKE-1\tdevin\twork\texample/phantom\tFixture',
    'PARKED-DEP.devin\tRQ-REBASE-PHANTOM-7777-aaa1111\tdevin\twork\texample/phantom\tFixture',
  ].join('\n'));
  const recorded = await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS });
  expect(recorded.wrote).toBe(true);
  if (!recorded.wrote) return;

  const boardPath = leaderBoardPath(root);
  expect(boardPath).toBe(join(root, 'coordination', 'leader-board.json'));
  const info = await stat(boardPath);
  expect(info.mode & 0o777).toBe(0o600);
  expect((await stat(join(root, 'coordination'))).mode & 0o777).toBe(0o700);

  const served = fleetBoardResponse(await readFleetBoard({ runsDir: root }), NOW_MS + 30_000);
  expect(served).toMatchObject({ schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 30 });
  expect(served.board?.generatedAt).toBe(new Date(NOW_MS).toISOString());
  expect(served.board?.conflictingPrs.count).toBe(1);
  expect(served.board?.sources.readyTsv).toBe('healthy');
});

it('keeps both parked-row encodings out of READY depth and counts distinct rebase PRs once', async () => {
  const tsv = [
    'READY\tRQ-FAKE-1\tdevin\twork\texample/phantom\tFixture',
    'READY\tRQ-FAKE-2\tdevin\tfast\texample/phantom\tFixture',
    'PARKED-HOLD\tRQ-FAKE-9\tdevin\twork\texample/phantom\tFixture',
    'RQ-FAKE-3\texample/phantom\tPARKED-DEP.codex\twork\tfake prompt',
    'READY\tRQ-REBASE-PHANTOM-7777-aaa1111\tdevin\twork\texample/phantom\tFixture',
    'READY\tRQ-REBASE-PHANTOM-7777-bbb2222\tcodex\twork\texample/phantom\tFixture',
    'READY\tRQ-REBASE-PHANTOM-8888-ccc3333\tcodex\twork\texample/phantom\tFixture',
  ].join('\n');
  expect(queueDepthByTier(readyRowsForDepth(tsv))).toEqual({ work: 4, fast: 1 });
  // Two jobs queue for PR 7777 but it is one PR in conflict.
  expect(conflictingPrIds(tsv)).toEqual(new Set(['PHANTOM-7777', 'PHANTOM-8888']));
});

it('refuses a symlinked board file and reports missing truthfully', async () => {
  expect((await readLeaderBoard({ runsDir: root })).status).toBe('missing');
  expect((await readFleetBoard({ runsDir: root })).status).toBe('missing');
  await mkdir(join(root, 'coordination'));
  const real = join(root, 'elsewhere.json');
  await writeFile(real, JSON.stringify({ schema: 'fleet.leader-board.v1', generatedAt: 'x' }));
  await symlink(real, join(root, 'coordination', 'leader-board.json'));
  expect((await readLeaderBoard({ runsDir: root })).status).toBe('unavailable');
});

it('bounds the conflict history across repeated records', async () => {
  await writeFile(join(root, 'queue', 'ready.tsv'),
    'READY\tRQ-REBASE-PHANTOM-1-aaaaaaa\tdevin\twork\texample/phantom\tFixture\n');
  for (let i = 0; i < 100; i++) {
    await recordLeaderBoard({ runsDir: root, nowMs: NOW_MS + i * 60_000 });
  }
  const read = await readLeaderBoard({ runsDir: root });
  expect(read.status).toBe('ok');
  if (read.status !== 'ok') return;
  expect(read.board.conflictingPrs.history.length).toBeLessThanOrEqual(96);
  const raw = await readFile(leaderBoardPath(root), 'utf8');
  expect(raw.endsWith('\n')).toBe(true);
});
