import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetDrip, cmdFleetDrip, formatFleetDrip } from '../src/cli/fleet-drip.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2);
let out: string[];
const dirs: string[] = [];
beforeEach(() => { out = []; vi.spyOn(console, 'log').mockImplementation((v: unknown) => { out.push(String(v)); }); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('fleet drip', () => {
  it('reports open PRs, limit, markers and oldest age', async () => {
    const r = await buildFleetDrip('/x', { readOpenPrs: async () => 280, readMarkers: async () => [NOW - 6.5 * DAY, NOW - DAY], now: () => NOW });
    expect(r).toMatchObject({ openPrs: 280, limit: 250, overLimit: true, waitingJobs: 2, oldestMarkerAgeDays: 6 });
    expect(formatFleetDrip(r)).toBe('280 open PRs of 250 (over the limit); 2 finished jobs waiting in the drip, oldest waiting 6d');
  });

  it('prints unknown, never zero, for unread sources', async () => {
    const r = await buildFleetDrip('/x', { readOpenPrs: async () => null, readMarkers: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ openPrs: 'unknown', overLimit: 'unknown', waitingJobs: 'unknown', oldestMarkerAgeDays: 'unknown' });
    const line = formatFleetDrip(r);
    expect(line).toBe('unknown open PRs of 250; unknown jobs waiting in the drip, oldest unknown');
    expect(line).not.toMatch(/\b0\b/);
  });

  it('a readable empty drip is a real zero with no oldest', async () => {
    const r = await buildFleetDrip('/x', { readOpenPrs: async () => 100, readMarkers: async () => [], now: () => NOW });
    expect(r).toMatchObject({ overLimit: false, waitingJobs: 0, oldestMarkerAgeDays: null });
    expect(formatFleetDrip(r)).toBe('100 open PRs of 250; 0 finished jobs waiting in the drip');
  });

  it('--json prints one parseable line; bad args exit 2', async () => {
    expect(await cmdFleetDrip(['--json'], { readOpenPrs: async () => 5, readMarkers: async () => [], now: () => NOW })).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).schema).toBe('fleet.drip.v1');
    expect(await cmdFleetDrip(['--nope'])).toBe(2);
    expect(await cmdFleetDrip(['--help'])).toBe(0);
  });

  it('default marker reader counts only regular .phdrip files under queue/run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drip-')); dirs.push(root);
    const run = join(root, 'queue/run'); mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'a.phdrip'), ''); writeFileSync(join(run, 'b.phdrip'), ''); writeFileSync(join(run, 'c.done'), '');
    const old = new Date(NOW - 3 * DAY); utimesSync(join(run, 'a.phdrip'), old, old);
    const fresh = new Date(NOW); utimesSync(join(run, 'b.phdrip'), fresh, fresh);
    expect(await cmdFleetDrip(['--json', '--root', root], { readOpenPrs: async () => 251, now: () => NOW })).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ waitingJobs: 2, oldestMarkerAgeDays: 3, overLimit: true });
    out = [];
    expect(await cmdFleetDrip(['--json', '--root', join(root, 'missing')], { readOpenPrs: async () => 1 })).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ waitingJobs: 'unknown' });
  });

  it('is registered as a fleet verb', () => { expect(FLEET_SUBCOMMAND_LOADERS['drip']).toBeTypeOf('function'); });
});
