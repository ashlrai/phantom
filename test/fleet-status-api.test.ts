import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fleetStatusApi } from '../src/core/fleet/status-api.js';
import { cmdFleetStatusApi } from '../src/cli/fleet-status-api.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
test('projects bounded observations without free text and expires availability', async () => {
  root = await mkdtemp(join(tmpdir(), 'status-api-'));
  await mkdir(join(root, 'queue'));
  const now = Date.parse('2026-01-01T12:00:00Z');
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: '2026-01-01T12:00:00Z', paused: false, mem_free_pct: 50,
    lanes: { work: { running: 1, target: 3, queued: 0, held: false, held_reason: '/secret/path' } }, rollup_24h: { by_lane: { work: { merged: 2 } } }, secret: 'private-value' }));
  await writeFile(join(root, 'queue/claimed.tsv'), 'job-1\twork\twork\t12:00\t1767268800\n');
  const report = await fleetStatusApi(root, () => now);
  expect(report.sessions).toEqual([{ job: 'job-1', lane: 'work', tier: 'work', claimedAt: '2026-01-01T12:00:00.000Z' }]);
  expect(report.lanes[0]).toMatchObject({ available: 2, merged24h: 2 });
  expect(report.queue).toBeNull();
  expect(JSON.stringify(report)).not.toMatch(/private-value|secret\/path/);
  expect((await fleetStatusApi(root, () => now + 60_001)).lanes[0]?.available).toBeNull();
});
test('missing sources remain unknown and CLI rejects invalid arguments', async () => {
  root = await mkdtemp(join(tmpdir(), 'status-api-'));
  const report = await fleetStatusApi(root, () => 0);
  expect(report.sessions).toBeNull();
  expect(report.queue).toBeNull();
  expect(report.publishedLastHour).toBeNull();
  expect(await cmdFleetStatusApi(['--bad'])).toBe(2);
});
