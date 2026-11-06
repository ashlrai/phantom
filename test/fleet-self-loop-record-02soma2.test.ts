import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSelfLoopRecord } from '../src/cli/fleet-self-loop-record.js';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';

const summary = { v: 1, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:01.000Z', elapsedMs: 1000, durationMs: 1000, intervalMs: 1000, ticks: 1, failures: 0, busy: 0, termination: 'duration', lastReport: null };
const setup = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loop-record-'))); return { dir, file: join(dir, 'result.json') }; };
const fake = (text: string, code = 0): typeof cmdFleetSelfLoop => async (_args, deps) => { deps?.output?.(text); return code; };

describe('fleet self-loop-record', () => {
  it('persists summaries privately and forwards controls once, including failures', async () => {
    const { dir, file } = setup();
    try {
      let forwarded: string[] = [];
      const loop: typeof cmdFleetSelfLoop = async (args, deps) => { forwarded = args; deps?.output?.(JSON.stringify({ ...summary, failures: 1 })); return 7; };
      const receipts: string[] = [];
      const args = ['--result-file', file, '--duration-ms', '1000', '--interval-ms', '1000', '--failure-backoff-max-ms', '2000', '--busy-backoff-max-ms', '2000', '--runs-dir', dir, '--apply'];
      expect(await cmdFleetSelfLoopRecord(args, { loop, output: x => receipts.push(x) })).toBe(7);
      expect(forwarded).toEqual([...args.slice(2), '--json']);
      expect(JSON.parse(readFileSync(file, 'utf8')).summary.failures).toBe(1);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(receipts[0]!).persisted).toBe(true);
      expect(readdirSync(dir)).toEqual(['result.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves prior content on bad output, errors and failed writes', async () => {
    const { dir, file } = setup();
    try {
      writeFileSync(file, 'old');
      for (const loop of [fake('{}'), fake('x'.repeat(65537)), async () => 0, async () => { throw Error('private'); }]) {
        expect(await cmdFleetSelfLoopRecord(['--result-file', file], { loop, output: () => {} })).not.toBe(0);
        expect(readFileSync(file, 'utf8')).toBe('old');
      }
      expect(await cmdFleetSelfLoopRecord(['--result-file', file], { loop: fake(JSON.stringify(summary)), rename: () => { throw Error('fail'); }, output: () => {} })).not.toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('old');
      expect(readdirSync(dir)).toEqual(['result.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects unsafe targets and wrapper flags before delegation', async () => {
    const { dir, file } = setup();
    try {
      symlinkSync(join(dir, 'missing'), file);
      let calls = 0;
      const loop: typeof cmdFleetSelfLoop = async () => { calls++; return 0; };
      for (const args of [['--result-file', file], ['--result-file', dir], ['--result-file', file, '--json'], ['--result-file', file, '--stream'], ['--result-file', file, '--result-file', file], []]) {
        expect(await cmdFleetSelfLoopRecord(args, { loop, output: () => {} })).not.toBe(0);
      }
      expect(calls).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('records completed passes from the real loop with a fake clock and ticks', async () => {
    const { dir, file } = setup();
    try {
      let clock = 0, ticks = 0;
      const result = await cmdFleetSelfLoopRecord(['--result-file', file, '--duration-ms', '2500', '--interval-ms', '1000'], {
        output: () => {}, now: () => clock,
        loopDeps: { now: () => clock, tick: async () => ({ exitCode: 0, report: { state: 'ran', pass: ++ticks } }), sleep: async ms => { clock += ms; }, onSignal: () => () => {} },
      });
      expect(result).toBe(0);
      const record = JSON.parse(readFileSync(file, 'utf8'));
      expect(record.summary.ticks).toBe(3);
      expect(record.summary.lastReport.pass).toBe(3);
      expect(record.finishedAt).toBe(new Date(2500).toISOString());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
