import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSelfLoopRecord } from '../src/cli/fleet-self-loop-record.js';
import type { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';

const setup = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'live-record-'))); return { dir, file: join(dir, 'result.json') }; };
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const pass = (n: number) => JSON.stringify({ v: 1, record: 'pass', pass: n, exitCode: 0, state: 'ran', report: { n } });

describe('live self-loop receipts', () => {
  it('persists each pass before the next tick and completes on a failed tick', async () => {
    const { dir, file } = setup();
    try {
      let clock = 0, ticks = 0, cleaned = false;
      const code = await cmdFleetSelfLoopRecord(['--result-file', file, '--live', '--duration-ms', '5000', '--interval-ms', '1000', '--max-ticks', '2'], {
        output: () => {}, now: () => clock,
        loopDeps: { now: () => clock, sleep: async ms => { clock += ms; }, onSignal: () => () => { cleaned = true; },
          tick: async () => {
            ticks++;
            if (ticks === 2) expect(read(file)).toMatchObject({ status: 'running', latest: { record: 'pass', pass: 1 } });
            return { exitCode: ticks === 2 ? 1 : 0, report: { state: 'ran', tick: ticks } };
          } },
      });
      expect(code).toBe(1);
      expect(cleaned).toBe(true);
      const result = read(file);
      expect(result).toMatchObject({ v: 1, status: 'completed', latest: { record: 'summary', ticks: 2, failures: 1, termination: 'max-ticks' } });
      expect(Object.keys(result).sort()).toEqual(['latest', 'startedAt', 'status', 'updatedAt', 'v']);
      expect(result.latest.lastReport.tick).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('forwards controls once and refuses malformed records without replacing a valid pass', async () => {
    const { dir, file } = setup();
    try {
      let forwarded: string[] = [];
      const loop: typeof cmdFleetSelfLoop = async (args, deps) => {
        forwarded = args;
        deps?.output?.(pass(1));
        deps?.output?.('{"v":1,"record":"pass","pass":2}');
        return 0;
      };
      expect(await cmdFleetSelfLoopRecord(['--live', '--result-file', file, '--duration-ms', '1000', '--apply'], { loop, output: () => {} })).toBe(1);
      expect(forwarded).toEqual(['--duration-ms', '1000', '--apply', '--stream']);
      expect(read(file)).toMatchObject({ status: 'running', latest: { pass: 1 } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stops admission and cleans up after a failed rename', async () => {
    const { dir, file } = setup();
    try {
      writeFileSync(file, 'prior');
      let ticks = 0, cleaned = false;
      const code = await cmdFleetSelfLoopRecord(['--live', '--result-file', file, '--duration-ms', '5000', '--interval-ms', '1000'], {
        output: () => {}, rename: () => { throw Error('failed'); },
        loopDeps: { now: () => 0, tick: async () => { ticks++; return { exitCode: 0, report: null }; },
          sleep: async () => { throw Error('unexpected sleep'); }, onSignal: () => () => { cleaned = true; } },
      });
      expect(code).toBe(1);
      expect(ticks).toBe(1);
      expect(cleaned).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('prior');
      expect(readdirSync(dir)).toEqual(['result.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the default final-summary format', async () => {
    const { dir, file } = setup();
    try {
      const code = await cmdFleetSelfLoopRecord(['--result-file', file, '--duration-ms', '1000'], {
        output: () => {}, now: () => 0,
        loopDeps: { now: () => 0, tick: async () => ({ exitCode: 0, report: null }), sleep: async () => {}, onSignal: handler => { handler(); return () => {}; } },
      });
      expect(code).toBe(0);
      expect(Object.keys(read(file)).sort()).toEqual(['finishedAt', 'startedAt', 'summary', 'v']);
      expect(read(file).summary).toMatchObject({ v: 1, ticks: 1, termination: 'interrupted' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
