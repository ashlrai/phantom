import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLanes } from '../src/cli/lanes.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const last = (out: ReturnType<typeof vi.spyOn>): string => String(out.mock.calls.at(-1)![0]);
const lines = (out: ReturnType<typeof vi.spyOn>): string[] => out.mock.calls.map(c => String(c[0]));

const SLOTS = {
  lanes: {
    claude: { target: 2, floor: 0, ceiling: null, held: false },
    'codex-personal': { target: 1, floor: 0, ceiling: null, held: false },
    devin: { target: 1, floor: 0, ceiling: null, held: true, held_reason: 'quota hold' },
    grok: { target: 1, floor: 0, ceiling: null, held: false },
  },
};

function status(running: Record<string, number>): Record<string, unknown> {
  const lanes: Record<string, unknown> = {};
  for (const [lane, n] of Object.entries(running)) {
    lanes[lane] = { running: n, target: 2, queued: 0, floor: 0, ceiling: null, effective_target: 2, held: false };
  }
  return { schema: 'dispatchd.status.v1', last_tick: new Date().toISOString(), paused: false, mem_free_pct: 50, lanes };
}

async function runsDirWith(files: { slots?: unknown; status?: unknown; jobs?: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lanes-route-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'), { recursive: true });
  await mkdir(join(dir, 'metrics'), { recursive: true });
  if (files.slots !== undefined) await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify(files.slots));
  if (files.status !== undefined) await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify(files.status));
  if (files.jobs !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.jobs);
  return dir;
}

describe('phm lanes route', () => {
  it('picks the lane with the most room and reports every skip as lanes.route.v1', async () => {
    const dir = await runsDirWith({
      slots: SLOTS,
      status: status({ claude: 0, 'codex-personal': 1, devin: 0, grok: 0 }),
      jobs: '{}\n',
    });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['route', '--json'], { runsDir: dir })).toBe(0);
    const report = JSON.parse(last(out));
    expect(report.schema).toBe('lanes.route.v1');
    expect(report.lane).toBe('claude');
    expect(report.testOnly).toBe(false);
    expect(report.targetsState).toBe('healthy');
    expect(report.statusState).toBe('healthy');
    expect(report.ledgerKnown).toBe(true);
    const byLane = new Map(report.skipped.map((s: { lane: string; kind: string }) => [s.lane, s.kind]));
    expect(byLane.get('codex-personal')).toBe('full');
    expect(byLane.get('devin')).toBe('held');
    expect(byLane.get('grok')).toBe('paid-unproven');
    expect(report.skipped.find((s: { lane: string }) => s.lane === 'devin')?.reason).toContain('quota hold');
  });

  it('prints the pick and the skips in plain words', async () => {
    const dir = await runsDirWith({ slots: SLOTS, status: status({ claude: 0, 'codex-personal': 1, devin: 0, grok: 0 }) });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['route'], { runsDir: dir })).toBe(0);
    const printed = lines(out);
    expect(printed).toContain('Chosen: claude.');
    expect(printed.some(l => l.includes('codex-personal') && l.includes('target'))).toBe(true);
    expect(printed.some(l => l.includes('grok') && l.includes('flat-rate'))).toBe(true);
    expect(printed[0]).toContain('Job history is unavailable');
  });

  it('fails closed when the lane-targets snapshot is missing', async () => {
    const dir = await runsDirWith({ status: status({ claude: 0 }) });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['route', '--json'], { runsDir: dir })).toBe(0);
    const report = JSON.parse(last(out));
    expect(report.lane).toBeNull();
    expect(report.targetsState).toBe('missing');
    expect(report.skipped).toEqual([
      expect.objectContaining({ lane: '*', kind: 'snapshot', reason: expect.stringContaining('missing') }),
    ]);
  });

  it('withholds the pick when running counts cannot be read', async () => {
    const dir = await runsDirWith({ slots: SLOTS });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['route', '--json'], { runsDir: dir })).toBe(0);
    const report = JSON.parse(last(out));
    expect(report.statusState).toBe('missing');
    expect(report.lane).toBeNull();
    expect(report.skipped[0]).toEqual(expect.objectContaining({ lane: '*', kind: 'snapshot', reason: expect.stringContaining('Running counts are missing') }));
  });

  it('accepts --size, --lane and --since and reports them', async () => {
    const dir = await runsDirWith({ slots: SLOTS, status: status({ claude: 0, 'codex-personal': 1, devin: 0, grok: 0 }) });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['route', '--size', 'md', '--lane', 'devin', '--since', '7d', '--json'], { runsDir: dir })).toBe(0);
    const report = JSON.parse(last(out));
    expect(report).toMatchObject({ size: 'md', named: 'devin' });
    expect(Date.parse(report.since)).toBeGreaterThan(Date.now() - 8 * 86_400_000);
  });

  it('rejects bad flags', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = await runsDirWith({ slots: SLOTS, status: status({}) });
    expect(await cmdLanes(['route', '--nope'], { runsDir: dir })).toBe(2);
    expect(await cmdLanes(['route', '--size'], { runsDir: dir })).toBe(2);
    expect(await cmdLanes(['route', '--size', '--json'], { runsDir: dir })).toBe(2);
    expect(await cmdLanes(['route', 'extra'], { runsDir: dir })).toBe(2);
    expect(await cmdLanes(['route', '--since', 'bogus'], { runsDir: dir })).toBe(2);
  });
});
