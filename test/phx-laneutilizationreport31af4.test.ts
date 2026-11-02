import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/agents/lane-utilization.js';
import { readRunsHistory, type ReadRunsHistoryOptions, type RunsSample } from '../src/core/fleet/runs-history.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const lane = (name: string, running = 1, target = 3, held = false) => ({ lane: name, running, target, held, queued: 0 });
const sample = (minutes: number, lanes = [lane('fake-a')], paused: boolean | null = false): RunsSample =>
  ({ at: at(minutes), lanes, paused, workers: null, leaders: null });
let root: string;
let file: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fake-lane-util-')); file = join(root, 'history.jsonl'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function report(args = ['--hours', '1']) {
  let output = '';
  const read = vi.fn((opts: ReadRunsHistoryOptions) => readRunsHistory({ ...opts, file, now: () => now }));
  const code = await run(args, { read, write: text => { output += text; } });
  return { code, json: JSON.parse(output), read };
}
async function rows(samples: RunsSample[], suffix = '') {
  const content = `${samples.map(s => JSON.stringify(s)).join('\n')}\n${suffix}`;
  await writeFile(file, content);
  return content;
}

describe('lane utilization report', () => {
  it('weights irregular intervals, target changes, and capped gaps while preserving source health', async () => {
    const content = await rows([
      sample(45, [lane('fake-a', 2, 5)]), sample(60, [lane('fake-a', 1, 3)]),
      sample(58, [lane('fake-a', 2, 4)]), sample(55, [lane('fake-a', 0, 2)]),
    ], '{fake invalid json\n');
    const result = await report();
    expect(result.code).toBe(0);
    expect(result.read).toHaveBeenCalledWith({ hours: 1 });
    expect(result.json).toMatchObject({ schema: 'phantom.lane-utilization.v1', sourceState: 'degraded', dropped: 1,
      sampleCount: 4, maxGapSeconds: 300, lanes: [{ lane: 'fake-a', coveredSeconds: 600, unknownSeconds: 3000,
        occupiedSlotSeconds: 480, targetSlotSeconds: 1680, dispatchableSpareSlotSeconds: 1200 }] });
    expect(await readFile(file, 'utf8')).toBe(content);
  });
  it('separates held, paused, overlapping and unknown pause durations from spare', async () => {
    await rows([sample(60, [lane('fake-a', 1, 4, true)]), sample(59, [lane('fake-a', 2, 5)], true),
      sample(58, [lane('fake-a', 0, 3, true)], true), sample(57, [lane('fake-a', 1, 3)], null),
      sample(56, [lane('fake-a', 5, 3)]), sample(55)]);
    const { json } = await report();
    expect(json.lanes[0]).toMatchObject({ coveredSeconds: 300, unknownSeconds: 3300, heldSeconds: 120,
      pausedSeconds: 120, pauseUnknownSeconds: 60, occupiedSlotSeconds: 540,
      targetSlotSeconds: 1080, dispatchableSpareSlotSeconds: 0 });
  });
  it('reports missing history and does not fabricate coverage from one observation', async () => {
    expect((await report()).json).toMatchObject({ sourceState: 'missing', sampleCount: 0, lanes: [] });
    expect((await report(['--hours', '1', '--lane', 'fake-a'])).json.lanes[0]).toMatchObject({ coveredSeconds: 0, unknownSeconds: 3600 });
    await rows([sample(30)]);
    expect((await report()).json.lanes[0]).toMatchObject({ coveredSeconds: 0, unknownSeconds: 3600, occupiedSlotSeconds: 0 });
  });
  it('selects lane IDs exactly and treats missing lane endpoints and duplicate times as unknown', async () => {
    await rows([sample(60, [lane('fake-a'), lane('fake-ab')]), sample(59, [lane('fake-a'), lane('fake-ab')]),
      sample(58, [lane('fake-ab')]), sample(57, [lane('fake-a')]), sample(57, [lane('fake-a')]), sample(56, [lane('fake-a')])]);
    const { json } = await report(['--lane', 'fake-a', '--hours', '1']);
    expect(json.lanes).toHaveLength(1);
    expect(json.lanes[0]).toMatchObject({ lane: 'fake-a', coveredSeconds: 60, unknownSeconds: 3540 });
    expect((await report(['--hours', '1', '--lane', 'fake'])).json.lanes[0]).toMatchObject({ lane: 'fake', coveredSeconds: 0 });
  });
  it('validates arguments, shows help, and handles reader errors without leaking details', async () => {
    const read = vi.fn(async () => { throw new Error('fake private path'); });
    let output = '';
    const write = (text: string) => { output += text; };
    for (const args of [[], ['--hours', '0'], ['--hours', '169'], ['--hours', '1.5'], ['--hours', '1', '--hours', '2'], ['--hours', '1', '--lane']]) {
      expect(await run(args, { read, write })).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    output = '';
    expect(await run(['--help'], { read, write })).toBe(0);
    expect(output).toContain('--hours 1..168 [--lane ID]');
    output = '';
    expect(await run(['--hours', '1'], { read, write })).toBe(1);
    expect(output).not.toContain('fake private path');
  });
});
