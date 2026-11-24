import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetVitals, readFleetVitalsView, readHostVitals } from '../src/cli/fleet-vitals.js';
import { newYorkWallToEpoch } from '../src/core/fleet/leader-liveness-evidence.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const NOW = Date.parse('2026-11-16T23:00:00Z');
const MM = 'OPUS-LEADER loop sha mismatch, refused';
async function fake(plan?: string, events?: string) {
  const root = await mkdtemp(join(tmpdir(), 'leader-608s-')); roots.push(root);
  await mkdir(join(root, 'leader')); await mkdir(join(root, 'queue'));
  if (plan !== undefined) await writeFile(join(root, 'leader/PLAN-LOG.md'), plan);
  if (events !== undefined) await writeFile(join(root, 'queue/dispatch-events.log'), events);
  return root;
}

it('reads leader evidence with the disk sample absent and keeps every existing diagnostic', async () => {
  const root = await fake('## 2026-11-16 ~16:00 ET\n', `2026-11-16T22:00:00Z ${MM}\n2026-11-16T22:30:00+00:00 ${MM}\n`);
  const view = await readFleetVitalsView(root, NOW);
  expect(view.disk).toBeNull();
  expect(view.status).toBe('unknown');
  expect(view.leader_liveness).toMatchObject({ source: 'leader/PLAN-LOG.md', as_of: '2026-11-16T21:00:00.000Z', age_seconds: 7200, flagged_red: false, mismatch_count: 2 });
  for (const key of ['launch', 'launchCost', 'emptyCauses', 'local_models', 'stuck']) expect(view).toHaveProperty(key);
  expect(Object.keys(await readHostVitals(root, NOW))).not.toContain('leader_liveness'); // HostVitals shape unchanged
});

it('plan heading: old is evidence only; future, malformed, DST-ambiguous and unzoned stay unknown', async () => {
  const age = async (plan: string) => (await readFleetVitalsView(await fake(plan), NOW)).leader_liveness;
  expect(await age('## 2026-11-16 ~10:00 ET\n')).toMatchObject({ flagged_red: true, age_seconds: 28_800, authority: 'none' });
  expect(await age('## 2026-11-16T22:30:00Z\n')).toMatchObject({ time_basis: 'explicit-zone', age_seconds: 1800 });
  for (const bad of ['## 2026-11-16 ~19:00 ET\n', '## 2026-11-16T23:30:00Z\n', '## 2026-13-45 ~99:99 ET\n', '## 2026-11-01 ~01:30 ET\n',
    '## 2026-03-08 ~02:30 ET\n', '## 2026-11-16 15:00\n', '## 2026-11-16T15:00:00\n', 'no headings\n', ''])
    expect(await age(bad), bad).toMatchObject({ as_of: null, age_seconds: null, age_hours: null, flagged_red: null });
  expect(newYorkWallToEpoch(2026, 7, 1, 12, 0)).toBe(Date.parse('2026-07-01T16:00:00Z')); // EDT
});

it('counts only valid, non-future mismatch events in the prior 24h', async () => {
  const events = [`2026-11-16T22:00:00Z ${MM}`, `2026-11-15T22:59:59Z ${MM}`, `2026-11-16T23:30:00Z ${MM}`, `no timestamp ${MM}`,
    `2026-11-16 22:00:00 ${MM}`, '2026-11-16T22:00:00Z unrelated'].join('\n');
  const l = (await readFleetVitalsView(await fake('', events), NOW)).leader_liveness;
  expect(l).toMatchObject({ mismatch_count: 1, mismatch_unusable_lines: 3 });
});

it('unreadable mismatch evidence is unknown (not 0) and does not hide the planner age', async () => {
  const root = await fake('## 2026-11-16T22:00:00Z\n');
  await mkdir(join(root, 'queue/dispatch-events.log'));
  const l = (await readFleetVitalsView(root, NOW)).leader_liveness;
  expect(l).toMatchObject({ mismatch_count: null, mismatch_unusable_lines: null, age_seconds: 3600 });
  const unreadable = (await readFleetVitalsView(await fake('## 2026-11-16T22:00:00Z\n'), NOW)).leader_liveness;
  expect(unreadable.mismatch_count).toBeNull(); // missing log
});

it('CLI prints the leader line after existing lines, JSON gains the field, argument handling is unchanged', async () => {
  const root = await fake('## 2026-11-16T10:00:00Z\n', '');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  const lines = log.mock.calls.map(c => String(c[0]));
  expect(lines[0]).toMatch(/^Disk growth: /);
  expect(lines.some(l => l.startsWith('Launch queue: '))).toBe(true);
  expect(lines.at(-1)).toMatch(/^Leader liveness: planner age \d+\.\dh \(stale, evidence only\); mismatches \(24h\) 0$/);
  log.mockClear();
  expect(await cmdFleetVitals(['--runs-dir', root, '--json'])).toBe(0);
  const out = JSON.parse(String(log.mock.calls[0]![0]));
  expect(out.leader_liveness).toMatchObject({ mismatch_count: 0, authority: 'none' });
  expect(out).toHaveProperty('stuck');
  expect(await cmdFleetVitals(['--json', '--json'])).toBe(2);
  expect(await cmdFleetVitals(['--bogus'])).toBe(2);
});
