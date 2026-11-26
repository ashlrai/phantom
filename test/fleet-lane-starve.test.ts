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
    expect(findStarvedLanes(STATUS, READY)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 3, filler: 2, real: 1 },
      ],
      openRows: 0,
    });
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
    expect(findStarvedLanes(STATUS, ready)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 2, filler: 1, real: 1 },
      ],
      openRows: 0,
    });
  });
  it('does not count parked rows or comments as runnable work', () => {
    const ready = [
      'RQ-X-A123456Q8\tp1\tclaude-api',
      'PARKED-DEP.claude-api\tRQ-PD1\tclaude-api\twork\tphantom\t/prompt',
      'RQ-PD2\tphantom\tPARKED-DEP.claude-api\twork\t/prompt',
      'PARKED-MERGERATE.codex\tRQ-PM1\tcodex\twork\trepo\t/prompt',
      '# note\tbogus\tclaude-api',
    ].join('\n');
    expect(findStarvedLanes(STATUS, ready)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 1, real: 0 },
      ],
      openRows: 0,
    });
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
    expect(findStarvedLanes(STATUS, ready)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 1, real: 0 },
      ],
      openRows: 0,
    });
  });
  it('counts only bare and ready rows when the snapshot includes other statuses', () => {
    const ready = [
      'RQ-BARE\tp1\tclaude-api\twork\tprompt',
      'ready\tRQ-SF-A123456Q8\tclaude-api\twork\tphantom\t/prompt',
      'CLAIMED\tRQ-CLAIMED-A123456Q8\tclaude-api\twork\tphantom\t/prompt',
      'running\tRQ-RUNNING\tclaude-api\twork\tphantom\t/prompt',
      'DONE\tRQ-DONE\tclaude-api\twork\tphantom\t/prompt',
    ].join('\n');
    expect(findStarvedLanes(STATUS, ready)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 2, filler: 1, real: 1 },
      ],
      openRows: 0,
    });
  });
  it('counts dispatcher rows by the market-resolved lane hint, not the lane column', () => {
    const both = JSON.stringify({
      lanes: {
        'claude-api': { running: 1, target: 3, queued: 4 },
        codex: { running: 0, target: 2, queued: 3 },
      },
    });
    const ready = [
      // The requirements preferred_lane wins over the lane column.
      'RQ-MOVED-1\tphantom\tclaude-api\twork\t/prompt\t{"preferred_lane":"codex"}',
      'RQ-STAY-1\tphantom\tclaude-api\twork\t/prompt',
      // A spec-less row resolves its hint through the router-queue envelope.
      'RQ-ENV-1\tphantom\tclaude-api\twork\t/prompt',
    ].join('\n');
    const router = '- READY RQ-ENV-1 (lane=codex tier=work): envelope-hinted job\n';
    expect(findStarvedLanes(both, ready, router)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 0, real: 1 },
        { lane: 'codex', running: 0, target: 2, queued: 3, ready: 2, filler: 0, real: 2 },
      ],
      openRows: 0,
    });
  });
  it('reports lane-open market rows once as openRows and never counts market-invalid rows', () => {
    const ready = [
      // Explicit null preferred_lane is lane-open shared supply.
      'RQ-OPEN-1\tphantom\tclaude-api\twork\t/prompt\t{"preferred_lane":null}',
      // An empty lane cell with no spec is lane-open too.
      'RQ-OPEN-2\tphantom\t\twork\t/prompt',
      // Rows the market would reject are dead work: bad preferred_lane and bad JSON.
      'RQ-DEAD-1\tphantom\tclaude-api\twork\t/prompt\t{"preferred_lane":"NOT_A_LANE"}',
      'RQ-DEAD-2\tphantom\tclaude-api\twork\t/prompt\tnot-json',
      'RQ-KEEP-A123456Q8\tphantom\tclaude-api\twork\t/prompt',
    ].join('\n');
    expect(findStarvedLanes(STATUS, ready)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 1, real: 0 },
      ],
      openRows: 2,
    });
  });
  it('resolves a spec-less row through its router-queue envelope lane attr', () => {
    const both = JSON.stringify({
      lanes: {
        'claude-api': { running: 1, target: 3, queued: 4 },
        codex: { running: 0, target: 2, queued: 3 },
      },
    });
    const ready = 'RQ-ENV-2\tphantom\tclaude-api\twork\t/prompt';
    const router = '- READY RQ-ENV-2 (preferred_lane=codex): envelope job\n';
    expect(findStarvedLanes(both, ready, router).lanes).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 0, filler: 0, real: 0 },
      { lane: 'codex', running: 0, target: 2, queued: 3, ready: 1, filler: 0, real: 1 },
    ]);
    // Without the envelope the lane column stands, exactly like the market's fallback.
    expect(findStarvedLanes(both, ready).lanes).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 0, real: 1 },
      { lane: 'codex', running: 0, target: 2, queued: 3, ready: 0, filler: 0, real: 0 },
    ]);
  });
  it('attributes each job to its first valid ready row across queue formats and lane hints', () => {
    const status = JSON.stringify({ lanes: {
      'claude-api': { running: 1, target: 3, queued: 4 },
      codex: { running: 0, target: 2, queued: 3 },
    } });
    const ready = [
      'RQ-OPEN\tphantom\tclaude-api\twork\t/prompt\tnot-json',
      'RQ-OPEN\tphantom\t\twork\t/prompt',
      'READY\tRQ-OPEN\tcodex\twork\tphantom\t/prompt',
      'PARKED-DEP.codex\tRQ-FIRST-A123456Q8\tcodex\twork\tphantom\t/prompt',
      'READY\tRQ-FIRST-A123456Q8\tclaude-api\twork\tphantom\t/prompt',
      'RQ-FIRST-A123456Q8\tphantom\t\twork\t/prompt',
      'RQ-FIRST-A123456Q8\tphantom\tcodex\twork\t/prompt',
      'RQ-SECOND\tphantom\tcodex\twork\t/prompt',
      'RQ-SECOND\tphantom\tcodex\twork\t/prompt',
    ].join('\n');
    expect(findStarvedLanes(status, ready)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: 1, filler: 1, real: 0 },
        { lane: 'codex', running: 0, target: 2, queued: 3, ready: 1, filler: 0, real: 1 },
      ],
      openRows: 1,
    });
  });
  it('rejects malformed status', () => {
    expect(() => findStarvedLanes('{"lanes":{"a":{"running":"1"}}}', '')).toThrow();
  });
  it('skips a lane at its shed launch ceiling', () => {
    const shed = JSON.stringify({ lanes: { codex: { running: 1, target: 3, effective_target: 1, queued: 4 } } });
    expect(findStarvedLanes(shed, '')).toEqual({ lanes: [], openRows: 0 });
    const room = JSON.stringify({ lanes: { codex: { running: 0, target: 3, effective_target: 1, queued: 4 } } });
    expect(findStarvedLanes(room, '')).toEqual({
      lanes: [
        { lane: 'codex', running: 0, target: 1, queued: 4, ready: 0, filler: 0, real: 0 },
      ],
      openRows: 0,
    });
  });
  it('reports openRows null when ready.tsv is absent', () => {
    expect(findStarvedLanes(STATUS, null)).toEqual({
      lanes: [
        { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: null, filler: null, real: null },
      ],
      openRows: null,
    });
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
    expect(report.open_rows).toBe(0);
    expect(report.lanes[0]).toMatchObject({ lane: 'claude-api', filler: 2, real: 1 });
  });
  it('resolves spec-less rows through router-queue.md and reports open_rows', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), STATUS);
    writeFileSync(join(dir, 'queue', 'ready.tsv'), [
      'RQ-ENV-1\tphantom\tclaude-api\twork\t/prompt',
      'RQ-OPEN-1\tphantom\tclaude-api\twork\t/prompt\t{"preferred_lane":null}',
    ].join('\n'));
    writeFileSync(join(dir, 'queue', 'router-queue.md'), '- READY RQ-ENV-1 (lane=codex): job\n');
    const { code, lines } = await run();
    expect(code).toBe(1);
    const report = JSON.parse(lines[0]!);
    expect(report.open_rows).toBe(1);
    expect(report.lanes[0]).toMatchObject({ lane: 'claude-api', ready: 0, filler: 0, real: 0 });
  });
  it('prints the lane-open count in text output', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), STATUS);
    writeFileSync(join(dir, 'queue', 'ready.tsv'), 'RQ-OPEN-1\tphantom\tclaude-api\twork\t/prompt\t{"preferred_lane":null}');
    const { code, lines } = await run([]);
    expect(code).toBe(1);
    expect(lines).toContain('1 lane-open row(s) can run on any lane.');
  });
  it('prints unknown in plain text when ready.tsv is missing', async () => {
    writeFileSync(join(dir, 'queue', 'status.json'), STATUS);
    const { code, lines } = await run([]);
    expect(code).toBe(1);
    expect(lines).toEqual(['claude-api: 1/3 running, 4 queued; ready unknown']);
  });
  it.each([
    { readyFile: null, count: null },
    { readyFile: '', count: 0 },
  ])('reports $count in JSON with ready.tsv contents $readyFile', async ({ readyFile, count }) => {
    writeFileSync(join(dir, 'queue', 'status.json'), STATUS);
    if (readyFile !== null) writeFileSync(join(dir, 'queue', 'ready.tsv'), readyFile);
    const { code, lines } = await run();
    expect(code).toBe(1);
    const report = JSON.parse(lines[0]!);
    expect(report.lanes).toEqual([
      { lane: 'claude-api', running: 1, target: 3, queued: 4, ready: count, filler: count, real: count },
    ]);
    expect(report.open_rows).toBe(readyFile === null ? null : 0);
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
