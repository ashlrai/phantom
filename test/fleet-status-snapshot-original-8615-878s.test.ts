import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fleetStatusApi } from '../src/core/fleet/status-api.js';
import { cmdFleetStatusApi } from '../src/cli/fleet-status-api.js';

let root = '';
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

test('CLI totals all synthetic lanes before truncation and excludes source prose', async () => {
  root = await mkdtemp(join(tmpdir(), 'snapshot-878s-'));
  for (const dir of ['queue', 'leader', 'supervisor']) await mkdir(join(root, dir));
  const now = new Date(2026, 10, 24, 12).getTime();
  const at = new Date(now).toISOString();
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const lanes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`lane${i.toString().padStart(2, '0')}`, { running: 1, queued: 2, target: 3, held: false }]));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at, paused: false, lanes }));
  await writeFile(join(root, 'leader/PLAN-LOG.md'), '## 2026-11-24 12:00\n**CEO summary**\n- fictional journal prose\n');
  await writeFile(join(root, 'supervisor/status-main-guardian.md'), '# Main guardian status (2026-11-24 12:00:00)\n| fictional-repo-label | master | abcdef1 | red | 2026-11-24 12:00:00 | | | |');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetStatusApi(['--json'])).toBe(0);
  const snapshot = JSON.parse(log.mock.calls[0]![0] as string).snapshot;
  expect(snapshot).toMatchObject({ running: 20, queued: 40, laneActivityTruncated: true, queueObservedAt: at, mains: { known: true, red: 1 } });
  expect(snapshot.laneActivity).toHaveLength(16);
  expect(JSON.stringify(snapshot)).not.toMatch(/fictional journal prose|fictional-repo-label/);
});

test('fresh zero is measured while incomplete, stale and malformed evidence stays unknown', async () => {
  root = await mkdtemp(join(tmpdir(), 'snapshot-878s-'));
  await mkdir(join(root, 'queue'));
  const now = Date.parse('2026-11-24T12:00:00Z');
  const path = join(root, 'queue/status.json');
  const status = { last_tick: new Date(now).toISOString(), lanes: { a: { running: 0, queued: 0 }, b: { running: 0, queued: 0 } } };
  await writeFile(path, JSON.stringify(status));
  expect((await fleetStatusApi(root, () => now)).snapshot).toMatchObject({ running: 0, queued: 0 });
  await writeFile(path, JSON.stringify({ ...status, lanes: { ...status.lanes, b: { running: 0, queued: 'bad' } } }));
  expect((await fleetStatusApi(root, () => now)).snapshot).toMatchObject({ running: 0, queued: null });
  const stale = (await fleetStatusApi(root, () => now + 60_001)).snapshot;
  expect(stale).toMatchObject({ running: null, queued: null, queueState: 'stale', queueObservedAt: status.last_tick });
  expect(stale.collectionErrors).toContainEqual({ source: 'queue', code: 'stale' });
  await writeFile(path, '{invalid');
  const invalid = (await fleetStatusApi(root, () => now)).snapshot;
  expect(invalid).toMatchObject({ running: null, queued: null });
  expect(invalid.collectionErrors).toContainEqual({ source: 'queue', code: 'invalid' });
});
