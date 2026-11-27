import { afterEach, expect, it, vi } from 'vitest';
import { symlink } from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetVitals, readFleetVitals, readHostVitals } from '../src/cli/fleet-vitals.js';
import { readLaunchVitals } from '../src/core/fleet/launch-vitals.js';
import { readFleetCompute } from '../src/core/fleet/compute-view.js';
import { readLaunchCosts } from '../src/core/fleet/launch-cost.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

it('reads directory deltas and distinguishes missing, partial, stale and invalid evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitals-'));
  try {
    expect((await readFleetVitals(root)).status).toBe('unknown');
    await mkdir(join(root, 'queue'));
    const disk = { sampled_at: 100, previous_sampled_at: 90, free_gb: 200, timed_out: false,
      growth_gb_per_h: null, hours_to_reuse_only: null, directories: [{ path: 'logs', size_gb: 2, delta_gb: -1 }] };
    const save = () => writeFile(join(root, 'queue/disk-growth.json'), JSON.stringify(disk));
    await save();
    expect(await readFleetVitals(root, 100_000)).toMatchObject({ status: 'ok', disk });
    expect((await readFleetVitals(root, 1_000_001)).status).toBe('stale');
    expect((await readFleetVitals(root, 99_000)).status).toBe('unknown');
    disk.timed_out = true; await save();
    expect((await readFleetVitals(root, 100_000)).status).toBe('partial');
    await writeFile(join(root, 'queue/disk-growth.json'), '{}');
    expect((await readFleetVitals(root)).disk).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const row = { schema: 'fleet.launch-cost.v1', lane: 'codex', launchId: 'RQ-A.1', startedAt: '2026-11-16T00:00:00Z', windowSeconds: 60, sampledSeconds: 60, samples: 13, peakProcesses: 6, meanCpuPercentOneCore: 50, peakCpuPercentOneCore: 125, status: 'measured' };
async function fixture(files: Record<string, unknown>, jsonl: unknown[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'host-vitals-')); roots.push(root);
  await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
  for (const [name, value] of Object.entries(files)) await writeFile(join(root, 'queue', name), JSON.stringify(value));
  if (jsonl.length) await writeFile(join(root, 'metrics/launch-cost.jsonl'), jsonl.map(r => JSON.stringify(r)).join('\n'));
  return root;
}
const disk = { sampled_at: 100, previous_sampled_at: 90, free_gb: 200, timed_out: false, growth_gb_per_h: null, hours_to_reuse_only: null, directories: [{ path: 'logs', size_gb: 2, delta_gb: -1 }] };
const dispatcher = { last_tick: new Date(100_000).toISOString(), lanes: { claude: { running: 1, target: 8, queued: 3 } } };

it('keeps the disk contract byte-compatible and adds launch evidence only as extra fields', async () => {
  const root = await fixture({ 'disk-growth.json': disk, 'status.json': dispatcher }, [row]);
  const old = await readFleetVitals(root, 100_000);
  const host = await readHostVitals(root, 100_000);
  expect(host).toMatchObject({ schema: 'fleet.vitals.v1', status: old.status, disk: old.disk });
  expect(Object.keys(host).sort()).toEqual(['disk', 'emptyCauses', 'launch', 'launchCost', 'local_models', 'schema', 'status', 'stuck']);
  expect(host.local_models).toEqual({ loaded_models: null, last_unload_reason: null, models: [] });
  expect(Object.keys(old).sort()).toEqual(['disk', 'schema', 'status']);
  expect(host.launch).toEqual({ reason: null, nextWindowSeconds: null, queued: 3, lanes: [{ lane: 'claude', running: 1, target: 8, queued: 3 }] });
  expect(host.launchCost.launches).toHaveLength(1);
});

it('an absent launch source never changes the disk status', async () => {
  const root = await fixture({ 'disk-growth.json': disk });
  const host = await readHostVitals(root, 100_000);
  expect(host.status).toBe('ok');
  expect(host.launch.queued).toBeNull();
  expect(host.launchCost).toMatchObject({ source: 'missing', state: 'unknown', launches: [] });
});

it.each(['over_host', 'over_owned', 'settling', 'pressure', 'admit'])('does not guess the undocumented %s controller schema', async reason => {
  const root = await fixture({ 'admission-ctl.json': { reason }, 'status.json': dispatcher });
  expect(await readLaunchVitals(root, 100_000)).toEqual({ reason: null, nextWindowSeconds: null, queued: 3, lanes: [{ lane: 'claude', running: 1, target: 8, queued: 3 }] });
});
it('projects the guard reason and pacing at the report time across both views', async () => {
  const now = 1795350000 * 1000;
  const guard = { ts: new Date(now).toISOString(), settle_s: 300, last_admit: now / 1000 - 60,
    why: 'settle', total_running: 10, max_total_running: 48 };
  const root = await fixture({ 'admission-ctl.json': guard });
  const expected = { reason: 'waiting between starts', nextWindowSeconds: 240, queued: null, lanes: [] };
  expect((await readHostVitals(root, now)).launch).toEqual(expected);
  expect((await readFleetCompute({ home: root, runsDir: root, now })).launchVitals).toEqual(expected);
  expect(await readLaunchVitals(root, now + 240_000)).toMatchObject({ reason: 'guard allows a start', nextWindowSeconds: 0 });
  for (const time of [now - 1, now + 300_001]) {
    expect(await readLaunchVitals(root, time)).toMatchObject({ reason: null, nextWindowSeconds: null });
  }

  const path = join(root, 'queue/admission-ctl.json');
  await writeFile(path, JSON.stringify({ ...guard, why: 'over_host' }));
  expect(await readLaunchVitals(root, now)).toMatchObject({ reason: 'host busy', nextWindowSeconds: null });

  await writeFile(path, JSON.stringify({ ...guard, why: 'unrecognized private detail' }));
  expect(await readLaunchVitals(root, now)).toMatchObject({ reason: 'guard reports a wait', nextWindowSeconds: null });
});

it('does not invent a queue total when a lane is missing its count', async () => {
  const root = await fixture({ 'status.json': { ...dispatcher, lanes: { claude: { running: 0 } } } });
  expect(await readLaunchVitals(root, 100_000)).toMatchObject({ queued: null, lanes: [{ lane: 'claude', running: 0 }] });
});

it.each([
  undefined, 'invalid', new Date(99_999).toISOString(), new Date(160_001).toISOString(),
])('keeps dispatcher counts unknown with unusable last_tick %s and projects the fresh guard', async last_tick => {
  const root = await fixture({
    'status.json': { ...dispatcher, last_tick },
    'admission-ctl.json': { ts: 160, settle_s: 30, last_admit: 150, why: 'settle', total_running: 1, max_total_running: 8 },
  });
  expect(await readLaunchVitals(root, 160_000)).toEqual({
    reason: 'waiting between starts', nextWindowSeconds: 20, queued: null,
    lanes: [{ lane: 'claude', running: null, target: null, queued: null }],
  });
});

it('accepts the freshness boundary and distinguishes an empty lane map from an invalid one', async () => {
  const root = await fixture({ 'status.json': dispatcher });
  expect((await readLaunchVitals(root, 160_000)).queued).toBe(3);
  const path = join(root, 'queue/status.json');
  await writeFile(path, JSON.stringify({ ...dispatcher, lanes: {} }));
  expect((await readLaunchVitals(root, 160_000)).queued).toBe(0);
  await writeFile(path, JSON.stringify({ ...dispatcher, lanes: [] }));
  expect((await readLaunchVitals(root, 160_000)).queued).toBeNull();
});

it('reads measured, partial and unknown launch costs while projecting only metadata', async () => {
  const root = await fixture({}, [{ ...row, privatePayload: 'must-not-escape' }, { ...row, status: 'partial', sampledSeconds: 20 }, { ...row, status: 'unknown', peakProcesses: null, meanCpuPercentOneCore: null, peakCpuPercentOneCore: null }]);
  const report = await readLaunchCosts(root);
  expect(report.launches.map(r => r.status)).toEqual(['measured', 'partial', 'unknown']);
  expect(JSON.stringify(report)).not.toContain('must-not-escape');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root, '--json'])).toBe(0);
  const out = JSON.parse(String(log.mock.calls[0]![0]));
  expect(out.schema).toBe('fleet.vitals.v1');
  expect(out.local_models.loaded_models).toBeNull();
  expect(out.launchCost.launches).toHaveLength(3);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS.vitals!()).cmdFleetVitals).toBe('function');
});

it('fails closed for malformed, incomplete and symlink launch-cost evidence; bounds output', async () => {
  const root = await fixture({}, [{ ...row, sampledSeconds: 58.9 }, { ...row, peakProcesses: -1 }, { ...row, meanCpuPercentOneCore: 200 }, null]);
  expect(await readLaunchCosts(root)).toMatchObject({ source: 'degraded', state: 'unknown', launches: [] });
  await rm(join(root, 'metrics/launch-cost.jsonl'));
  expect(await readLaunchCosts(root)).toMatchObject({ source: 'missing', state: 'unknown' });
  await writeFile(join(root, 'private'), JSON.stringify(row)); await symlink(join(root, 'private'), join(root, 'metrics/launch-cost.jsonl'));
  expect(await readLaunchCosts(root)).toMatchObject({ source: 'degraded', launches: [] });
  expect((await readLaunchCosts(await fixture({}, Array.from({ length: 101 }, () => row)))).launches).toHaveLength(100);
});

it('rejects bad arguments and prints text with disk lines first', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--json', '--json'])).toBe(2);
  expect(await cmdFleetVitals(['--runs-dir'])).toBe(2);
  expect(await cmdFleetVitals(['--bogus'])).toBe(2);
  const root = await fixture({ 'disk-growth.json': disk });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  const lines = log.mock.calls.map(c => String(c[0]));
  expect(lines[0]).toMatch(/^Disk growth: /);
  expect(lines.some(l => l.startsWith('Launch queue: unknown'))).toBe(true);
  expect(lines.some(l => l.startsWith('Launch cost: unknown (source missing)'))).toBe(true);
  expect(lines).toContain('Next launch window: unknown');
  expect(lines).toContain('Local models: loaded models, memory fit and last unload reason unknown');
  expect(lines).toContain('Empty causes (24h): unknown');
  expect(lines).toContain('Jobs stuck: unknown');
});

it('adds one row for stuck jobs with the oldest age', async () => {
  const root = await fixture({});
  const at = (minute: number) => `2026-11-16 10:${String(minute).padStart(2, '0')}:00`;
  await writeFile(join(root, 'queue/dispatch-events.log'), [0, 5, 10].map(m => `${at(m)} DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm`).join('\n') + '\n');
  const now = new Date(2026, 10, 16, 12, 0, 0).getTime();
  expect((await readHostVitals(root, now)).stuck).toEqual({ count: 1, oldestAgeSeconds: 7200 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  expect(log.mock.calls.map(c => String(c[0])).some(l => /^1 job stuck; oldest /.test(l))).toBe(true);
});
