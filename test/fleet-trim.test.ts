import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetTrim, FLEET_TRIM_SCHEMA, trimFleet } from '../src/cli/fleet-trim.js';

const SECRET = 'status-file-secret-do-not-print';
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const lane = (running: number, target: number, queued: number, held = false) => ({ running, target, queued, held, note: SECRET });
const stats = (jobs: number, merged: number, merge_rate: number, empty_rate: number) => ({ jobs, merged, merge_rate, empty_rate, note: SECRET });

function status(patch: { running?: number; cap?: number; lanes?: Record<string, unknown>; by_lane?: Record<string, unknown> } = {}) {
  return {
    unrelated: SECRET,
    admission: { cap: patch.cap ?? 8, running: patch.running ?? 8, warnings: [SECRET] },
    lanes: patch.lanes ?? {},
    rollup_24h: { by_lane: patch.by_lane ?? {} },
  };
}

async function run(contents: unknown, args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-trim-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  await writeFile(path, text);
  const reader = vi.fn(async (_requested: string) => readFile(path, 'utf8'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetTrim(args, reader);
  expect(reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
  expect(await readFile(path, 'utf8')).toBe(text);
  const printed = String(output.mock.calls[0]?.[0] ?? '');
  expect(printed).not.toContain(SECRET);
  return { code, printed };
}

describe('trimFleet', () => {
  it('flags a starved lane only when every starved condition holds', () => {
    const lanes = {
      starved: lane(0, 2, 3),
      running: lane(1, 2, 3),
      idle: lane(0, 2, 0),
      zero: lane(0, 0, 3),
      held: lane(0, 2, 3, true),
    };
    expect(trimFleet(status({ lanes })).flagged.map(row => [row.lane, row.flag])).toEqual([['starved', 'starved']]);
    expect(trimFleet(status({ lanes, running: 7 })).flagged).toEqual([]);
    expect(trimFleet(status({ lanes, running: 9 })).flagged).toHaveLength(1);
  });

  it('flags waste at 10 jobs with merge rate under 0.3 or empty rate over 0.5', () => {
    const report = trimFleet(status({
      running: 0,
      lanes: { low: lane(1, 3, 0), empty: lane(1, 2, 0), fine: lane(1, 2, 0), few: lane(1, 2, 0), edge: lane(1, 2, 0) },
      by_lane: {
        low: stats(10, 2, 0.2, 0.1),
        empty: stats(20, 12, 0.6, 0.6),
        fine: stats(50, 25, 0.5, 0.5),
        few: stats(9, 0, 0, 1),
        edge: stats(10, 3, 0.3, 0.5),
      },
    }));
    expect(report.flagged.map(row => [row.lane, row.flag])).toEqual([['low', 'wastes'], ['empty', 'wastes']]);
    expect(report.suggestions.map(row => row.line)).toEqual(['SLOTS low 3 -> 2', 'SLOTS empty 2 -> 1']);
  });

  it('suggests no change for a wasting lane that is held or has no slots', () => {
    const report = trimFleet(status({
      running: 0,
      lanes: { held: lane(0, 2, 0, true), none: lane(0, 0, 0) },
      by_lane: { held: stats(12, 0, 0, 0.9), none: stats(12, 0, 0, 0.9) },
    }));
    expect(report.flagged).toHaveLength(2);
    expect(report.suggestions).toEqual([]);
  });

  it('treats a missing rollup as no waste evidence', () => {
    const { rollup_24h: _drop, ...bare } = status({ lanes: { a: lane(1, 1, 0) } });
    expect(trimFleet(bare).flagged).toEqual([]);
  });

  it('rejects malformed fields', () => {
    expect(() => trimFleet(status({ lanes: { a: lane(1, 1, 0) }, by_lane: { a: stats(10, 0, 1.5, 0) } }))).toThrow();
    expect(() => trimFleet(status({ lanes: { a: { running: 0, target: 1, queued: 0 } } }))).toThrow();
  });
});

describe('ashlr fleet trim', () => {
  const sample = status({
    lanes: { starved: lane(0, 2, 4), wasteful: lane(2, 3, 0) },
    by_lane: { wasteful: stats(12, 1, 0.08, 0.7) },
  });

  it('prints one plain line per flagged lane, then one per suggestion', async () => {
    const { code, printed } = await run(sample, []);
    expect(code).toBe(0);
    expect(printed.split('\n')).toEqual([
      'starved is starved: 4 queued, none running, the global cap is full.',
      'wasteful wastes slots: 1 merged of 12 jobs, merge rate 0.08, empty rate 0.7.',
      'SLOTS wasteful 3 -> 2',
    ]);
  });

  it('prints a typed read-only JSON report', async () => {
    const { code, printed } = await run(sample, ['--json']);
    expect(code).toBe(0);
    const body = JSON.parse(printed);
    expect(body).toMatchObject({ schema: FLEET_TRIM_SCHEMA, readOnly: true });
    expect(body.flagged.map((row: { flag: string }) => row.flag)).toEqual(['starved', 'wastes']);
    expect(body.suggestions).toEqual([{ lane: 'wasteful', from: 3, to: 2, line: 'SLOTS wasteful 3 -> 2' }]);
  });

  it('says so when nothing is flagged', async () => {
    const { code, printed } = await run(status(), []);
    expect(code).toBe(0);
    expect(printed).toBe('No lane is starved or wasting slots.');
  });

  it('exits 2 without echoing contents when status is unreadable', async () => {
    for (const bad of [`not json ${SECRET}`, '[]', { admission: { cap: 1, running: 1 }, lanes: [] }]) {
      const { code, printed } = await run(bad, ['--json']);
      expect(code).toBe(2);
      expect(JSON.parse(printed)).toEqual({ schema: FLEET_TRIM_SCHEMA, readOnly: true, error: 'Queue status is unreadable or invalid.' });
    }
  });

  it('prints usage for help and rejects unknown arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetTrim(['--help'])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('Usage: ashlr fleet trim');
    expect(await cmdFleetTrim(['--apply'])).toBe(2);
    expect(err).toHaveBeenCalledOnce();
  });

  it('is registered as a fleet verb', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['trim']!();
    expect(mod.cmdFleetTrim).toBe(cmdFleetTrim);
  });
});
