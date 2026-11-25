import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fleetStatusApi } from '../src/core/fleet/status-api.js';
import { cmdFleetStatusApi } from '../src/cli/fleet-status-api.js';

let root = '';
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
test('projects bounded observations without free text and expires availability', async () => {
  root = await mkdtemp(join(tmpdir(), 'status-api-'));
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'leader'));
  await writeFile(join(root, 'leader/PLAN-LOG.md'), '## 2026-01-01 12:00\n**CEO summary**\n- private-journal-text\n');
  const now = Date.parse('2026-01-01T12:00:00Z');
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: '2026-01-01T12:00:00Z', paused: false, mem_free_pct: 50,
    lanes: { work: { running: 1, target: 3, effective_target: 2, queued: 0, held: false, held_reason: '/secret/path' } }, rollup_24h: { by_lane: { work: { merged: 2 } } }, secret: 'private-value' }));
  await writeFile(join(root, 'queue/claimed.tsv'), 'job-1\twork\twork\t12:00\t1767268800\n');
  const report = await fleetStatusApi(root, () => now);
  expect(report.sessions).toEqual([{ job: 'job-1', lane: 'work', tier: 'work', claimedAt: '2026-01-01T12:00:00.000Z' }]);
  expect(report.awareness).toMatchObject({ schema: 'fleet.awareness.v1', queue: { laneQueued: 0 } });
  expect(report.awareness.lanes[0]).toMatchObject({ running: 1, target: 3, effectiveTarget: 2, available: 1 });
  expect(report.lanes[0]).toMatchObject({ running: 1, queued: 0, available: 1, effectiveTarget: 2, merged24h: 2 });
  expect(report.snapshot).toMatchObject({ queueState: 'fresh', running: 1, queued: 0, merged24h: 2 });
  expect(report.queue).toBeNull();
  expect(JSON.stringify(report)).not.toMatch(/private-value|secret\/path|private-journal-text/);
  const expired = await fleetStatusApi(root, () => now + 60_001);
  expect(expired.lanes[0]).toMatchObject({ running: null, queued: null, available: null, merged24h: null });
  expect(expired.snapshot).toMatchObject({ queueState: 'stale', running: null, queued: null, merged24h: null,
    queueObservedAt: '2026-01-01T12:00:00.000Z' });
});
test('missing sources remain unknown and CLI rejects invalid arguments', async () => {
  root = await mkdtemp(join(tmpdir(), 'status-api-'));
  const report = await fleetStatusApi(root, () => 0);
  expect(report.sessions).toBeNull();
  expect(report.queue).toBeNull();
  expect(report.publishedLastHour).toBeNull();
  expect(report.snapshot).toMatchObject({ queueState: 'unavailable', running: null, queued: null, merged24h: null,
    mains: { known: false, guardianState: 'unavailable' } });
  expect(report.snapshot.collectionErrors).toContainEqual({ source: 'queue', code: 'missing' });
  expect(await cmdFleetStatusApi(['--bad'])).toBe(2);
});

test('CLI exposes the shared collector from the configured runs directory', async () => {
  root = await mkdtemp(join(tmpdir(), 'status-api-cli-'));
  for (const dir of ['queue', 'supervisor']) await mkdir(join(root, dir));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  const now = new Date(2026, 10, 24, 12).getTime();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const at = new Date(now).toISOString();
  // A partial lane must not hide healthy lanes or turn unknown counts into zero.
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at, paused: false, mem_free_pct: 50,
    lanes: { codex: { running: 2, queued: 5, target: 3, held: false }, claude: { running: 0, queued: 'bad' } },
    rollup_24h: { merged: 7, by_lane: { codex: { merged: 7 }, claude: { merged: 0 } } } }));
  const wallTime = '2026-11-24 12:00:00';
  await writeFile(join(root, 'supervisor/status-main-guardian.md'), `# Main guardian status (${wallTime})\n| phantom | master | abcdef1 | green | ${wallTime} | | | |`);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetStatusApi(['--json'])).toBe(0);
  const report = JSON.parse(log.mock.calls[0]![0] as string);
  expect(report.snapshot).toMatchObject({ queueState: 'fresh', running: 2, queued: null, merged24h: 7,
    mains: { known: true, guardianState: 'fresh', green: 1 } });
  expect(report.snapshot.laneActivity).toEqual([
    { lane: 'claude', running: 0, queued: null }, { lane: 'codex', running: 2, queued: 5 },
  ]);
  expect(report.snapshot.lanes).toEqual(expect.arrayContaining([{ lane: 'claude', merged: 0, medianTtmS: null }]));
  expect(report.lanes[0]).toMatchObject({ lane: 'codex', running: null, queued: null, merged24h: null });
});
