import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetLaneStarve, findStarvedLanes as cliFindStarvedLanes } from '../src/cli/fleet-lane-starve.js';
import { FILLER_ID, findStarvedLanes, isParkedReadyRow } from '../src/core/fleet/lane-starve.js';

let dir: string;
const saved = process.env.ASHLR_RUNS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lane-starve-'));
  mkdirSync(join(dir, 'queue'));
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const STATUS = JSON.stringify({
  lanes: {
    'claude-api': { running: 1, target: 3, queued: 4 },
    codex: { running: 2, target: 2, queued: 9 },
    devin: { running: 0, target: 2, queued: 0 },
  },
});
const READY = [
  ['RQ-X-A123456Q8', 'p1', 'claude-api'],
  ['RQ-Y-A12345Q8', 'p1', 'claude-api'],
  ['RQ-Z-A9999999Q8', 'p2', 'claude-api'],
  ['RQ-W', 'p1', 'codex'],
].map(r => r.join('\t')).join('\n') + '\n';

async function run(args: string[] = ['--json']) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetLaneStarve(args);
  return { code, lines: out.mock.calls.map(c => String(c[0])) };
}

describe('FILLER_ID', () => {
  it('needs A, 6+ digits and Q8 at the end', () => {
    expect(FILLER_ID.test('RQ-A123456Q8')).toBe(true);
    expect(FILLER_ID.test('RQ-A12345Q8')).toBe(false);
    expect(FILLER_ID.test('RQ-A123456Q8X')).toBe(false);
  });
});

describe('findStarvedLanes', () => {
  it('keeps only lanes below target with queued work and splits ready rows', () => {
    expect(findStarvedLanes(STATUS, READY)).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 3, filler: 2, real: 1 },
    ]);
  });
  it('does not count parked or comment rows as ready supply', () => {
    const ready = [
      'RQ-A123456Q8\tp1\tclaude-api\twork\tprompt',
      'RQ-REAL\tp1\tclaude-api\twork\tprompt',
      // Status-first parked dialect: the marker leads and the real lane sits in the lane cell.
      'PARKED-DEP.claude-api\tRQ-PARKED-1\tclaude-api\twork\tphantom\tprompt',
      // Lane-column parked dialect: the marker sits in the lane cell.
      'RQ-PARKED-2\tphantom\tPARKED-DEP.codex\twork\tprompt',
      'RQ-PARKED-3\tphantom\tPARKED-HOLD.devin\twork\tprompt',
      // Comments are not rows, even when they contain tabs.
      '# fleet note\twith\ttabs',
    ].join('\n');
    expect(findStarvedLanes(STATUS, ready)).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 2, filler: 1, real: 1 },
    ]);
  });
  it('does not count parked rows or comments as runnable work', () => {
    const ready = [
      'RQ-X-A123456Q8\tp1\tclaude-api',
      'PARKED-DEP.claude-api\tRQ-PD1\tclaude-api\twork\tphantom\t/prompt',
      'RQ-PD2\tphantom\tPARKED-DEP.claude-api\twork\t/prompt',
      'PARKED-MERGERATE.codex\tRQ-PM1\tcodex\twork\trepo\t/prompt',
      '# note\tbogus\tclaude-api',
    ].join('\n');
    expect(findStarvedLanes(STATUS, ready)).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 1, real: 0 },
    ]);
  });
  it('keeps the CLI reader export compatible', () => {
    expect(cliFindStarvedLanes).toBe(findStarvedLanes);
  });
  it.each(['PARKED-DEP', 'parked-hold', 'PARKEDx'])('recognizes %s in either parked encoding', marker => {
    expect(isParkedReadyRow([marker, 'job', 'claude-api'])).toBe(true);
    expect(isParkedReadyRow(['job', 'repo', marker])).toBe(true);
    expect(isParkedReadyRow(['job', 'repo', 'claude-api'])).toBe(false);
  });
  it('reads the job id from status-first rows', () => {
    const ready = 'READY\tRQ-SF-A123456Q8\tclaude-api\twork\tphantom\t/prompt';
    expect(findStarvedLanes(STATUS, ready)).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 1, real: 0 },
    ]);
  });
  it('rejects malformed status', () => {
    expect(() => findStarvedLanes('{"lanes":{"a":{"running":"1"}}}', '')).toThrow();
  });
  it('skips a lane at its shed launch ceiling', () => {
    const shed = JSON.stringify({ lanes: { codex: { running: 1, target: 3, effective_target: 1, queued: 4 } } });
    expect(findStarvedLanes(shed, '')).toEqual([]);
    const room = JSON.stringify({ lanes: { codex: { running: 0, target: 3, effective_target: 1, queued: 4 } } });
    expect(findStarvedLanes(room, '')).toEqual([
      { lane: 'codex', running: 0, target: 1, queued: 4, ready: 0, filler: 0, real: 0 },
    ]);
  });
});

describe('cmdFleetLaneStarve', () => {
  it('prints JSON and exits 1 with FILLER_HOLD reported', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), STATUS);
    writeFileSync(join(dir, 'queue', 'ready.tsv'), READY);
    writeFileSync(join(dir, 'queue', 'FILLER_HOLD'), '');
    const { code, lines } = await run();
    expect(code).toBe(1);
    const report = JSON.parse(lines[0]!);
    expect(report.filler_hold).toBe(true);
    expect(report.lanes[0]).toMatchObject({ lane: 'claude-api', filler: 2, real: 1 });
  });
  it('prints plain text, tolerating missing ready.tsv and hold', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), STATUS);
    const { code, lines } = await run([]);
    expect(code).toBe(1);
    expect(lines).toEqual(['claude-api: 1/3 running, 4 queued; ready 0 = 0 filler + 0 real']);
  });
  it('exits 0 when nothing is starved', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({ lanes: {} }));
    const { code, lines } = await run([]);
    expect(code).toBe(0);
    expect(lines).toEqual(['No starved lanes.']);
  });
  it('excludes held lanes with queued work from starvation alerts', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({
      lanes: { 'claude-api': { running: 1, target: 3, queued: 4, held: true } },
    }));
    writeFileSync(join(dir, 'queue', 'ready.tsv'), READY);
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).lanes).toEqual([]);
  });
  it('exits 2 when status.json is missing', async () => {
    const { code, lines } = await run();
    expect(code).toBe(2);
    expect(JSON.parse(lines[0]!).error).toMatch(/Cannot read/);
  });
  it('rejects unknown arguments and prints help', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
  it('is registered', () => {
    expect(FLEET_SUBCOMMAND_LOADERS['lane-starve']).toBeTypeOf('function');
  });
});
