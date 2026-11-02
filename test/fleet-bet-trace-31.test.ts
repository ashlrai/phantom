import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBetTrace, defaultBetTraceReaders, readBetTrace, type BetTraceReaders } from '../src/cli/fleet-bet-trace.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));

const now = Date.parse('2026-10-31T23:13:00Z');
const at = Date.parse('2026-10-31T23:07:00Z');
function fixture(text: string, overrides: Partial<BetTraceReaders> = {}): BetTraceReaders {
  return {
    leaderOutputs: async () => [{ name: 'supervisor/out.1793488020.txt', at, text }],
    queueLines: async () => '', jobMetrics: async () => '', slots: async () => ({}), ...overrides,
  };
}
afterEach(() => vi.restoreAllMocks());
it('reconciles every job state with exact ids and terminal metrics ahead of stale queue entries', async () => {
  const readers = fixture([
    'BET phantom codex work QUEUED do work', 'BET phantom codex work LIVE do work',
    'BET phantom claude mid DONE do work', 'FIXUP phantom SKIP repair it',
    'FIXUP phantom LOST repair it', 'BET phantom codex work PREFIX do work',
  ].join('\n'), {
    queueLines: async () => '# RQ-QUEUEDQ8\nRQ-DONEQ8\tphantom\nRQ-PREFIXQ8-RETRY',
    jobMetrics: async () => [
      { job: 'RQ-LIVEQ8', event: 'launch' }, { job: 'RQ-DONEQ8', event: 'finish', outcome: 'failed' },
      { job: 'RQ-DONEQ8', event: 'enqueue' }, { job: 'RQ-FIXUP-SKIPQ8', event: 'precheck_skip' },
    ].map(row => JSON.stringify(row)).join('\n'),
  });
  const pass = (await readBetTrace(readers, now)).passes[0]!;
  expect(pass.commands.map(command => [command.id, command.state])).toEqual([
    ['RQ-QUEUEDQ8', 'queued'], ['RQ-LIVEQ8', 'launched'], ['RQ-DONEQ8', 'finished'],
    ['RQ-FIXUP-SKIPQ8', 'precheck_skip'], ['RQ-FIXUP-LOSTQ8', 'lost'], ['RQ-PREFIXQ8', 'lost'],
  ]);
  expect(pass.totals).toMatchObject({ queued: 1, launched: 1, finished: 1, precheck_skip: 1, lost: 2 });
});
it('exposes all six lost BETs in the Oct 31 19:07 pass and its ineffective SLOTS', async () => {
  const readers = fixture(Array.from({ length: 6 }, (_, i) => `BET phantom codex work LOST${i} task`).join('\n') + '\nSLOTS codex 6', {
    slots: async () => ({ lanes: { codex: { target: 2 } } }),
  });
  const pass = (await readBetTrace(readers, now)).passes[0]!;
  expect(pass.totals.lost).toBe(6);
  expect(pass.totals.overwritten).toBe(1);
  expect(pass.commands[6]).toMatchObject({ target: 6, currentTarget: 2, state: 'overwritten' });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await cmdFleetBetTrace(['--json'], readers, now)).toBe(1);
  expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ passes: [{ totals: { lost: 6 } }] });
});
it('compares slot targets, preserves each command and reports unavailable lanes', async () => {
  const pass = (await readBetTrace(fixture('SLOTS codex 2\nSLOTS codex 4\nSLOTS absent 1', {
    slots: async () => ({ codex: { target: 2 } }),
  }), now)).passes[0]!;
  expect(pass.commands.map(command => command.state)).toEqual(['applied', 'overwritten', 'unknown']);
});
it('waits strictly more than five minutes, including future passes', async () => {
  const readers = fixture('BET phantom codex work NEW task');
  for (const observation of [at - 1, at, at + 300_000]) {
    expect((await readBetTrace(readers, observation)).passes[0]!.commands[0]!.state).toBe('pending');
  }
  expect((await readBetTrace(readers, at + 300_001)).passes[0]!.totals.lost).toBe(1);
});
it.each([
  { queueLines: async () => null }, { jobMetrics: async () => null },
  { jobMetrics: async () => 'broken json' },
  { jobMetrics: async () => JSON.stringify({ job: 'RQ-XQ8', event: 'unrecognized' }) },
])('does not invent loss when evidence is unavailable or unrecognized (%#)', async overrides => {
  expect((await readBetTrace(fixture('BET phantom codex work X task', overrides), now)).passes[0]!.totals.unknown).toBe(1);
});
it('sorts passes and retains duplicate commands with line provenance without echoing prompt text', async () => {
  const report = await readBetTrace(fixture('', { leaderOutputs: async () => [
    { name: 'new', at: now, text: 'BET phantom codex work X private prompt' },
    { name: 'old', at, text: 'FIXUP phantom X private prompt\nFIXUP phantom X private prompt' },
  ] }), now);
  expect(report.passes.map(pass => pass.source)).toEqual(['old', 'new']);
  expect(report.passes[0]!.commands.map(command => command.line)).toEqual([1, 2]);
  expect(JSON.stringify(report)).not.toContain('private prompt');
});
it('emits JSON failure without source error contents and validates arguments before reading', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const leaderOutputs = vi.fn(async () => { throw new Error('private source detail'); });
  const readers = fixture('', { leaderOutputs });
  expect(await cmdFleetBetTrace(['--json', '--bad'], readers, now)).toBe(2);
  expect(leaderOutputs).not.toHaveBeenCalled();
  expect(await cmdFleetBetTrace(['--json'], readers, now)).toBe(2);
  expect(String(stdout.mock.calls[1]![0])).not.toContain('private source detail');
  expect(await cmdFleetBetTrace(['--help'], readers, now)).toBe(0);
});
it('reads only the specified local sources through the default adapter', async () => {
  const fs = await import('node:fs/promises');
  const root = '/fixture';
  const files: Record<string, string> = {
    '/fixture/supervisor/out.1793488020.txt': 'BET phantom codex work Q task\nSLOTS codex 2',
    '/fixture/queue/router-queue.md': '# RQ-QQ8', '/fixture/queue/ready.tsv': '',
    '/fixture/metrics/jobs.jsonl': '', '/fixture/queue/slots.json': '{"codex":{"target":2}}',
  };
  vi.spyOn(fs, 'readdir').mockResolvedValue(['out.1793488020.txt', 'ignored.txt'] as never);
  vi.spyOn(fs, 'stat').mockResolvedValue({ mtimeMs: now } as never);
  const read = vi.spyOn(fs, 'readFile').mockImplementation(async path => {
    const text = files[String(path)];
    if (text === undefined) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return text;
  });
  const report = await readBetTrace(defaultBetTraceReaders(root), now);
  expect(report.passes[0]!.at).toBe(new Date(at).toISOString());
  expect(report.passes[0]!.totals).toMatchObject({ queued: 1, applied: 1 });
  expect(read.mock.calls.map(call => String(call[0])).sort()).toEqual(Object.keys(files).sort());
});
