import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cmdFleetStagingInventoryBatch } from '../src/cli/fleet-staging-inventory-batch.js';
import { ELIGIBILITY, inventoryStaging } from '../src/core/fleet/staging-inventory.js';

type Report = Awaited<ReturnType<typeof inventoryStaging>>;
const report = (root: string): Report => ({
  schema: 'fleet.staging-inventory.v1', generatedAt: '2026-01-01T00:00:00.000Z', root,
  source: 'ok', complete: true, truncated: false, skippedSymlinks: 0,
  entries: [], totalMeasuredBytes: 0, cleanupEligibility: ELIGIBILITY,
});
const envelope = JSON.stringify({ version: 1, roots: ['/fake/a', '/fake/b'] });
const input = () => (async function* () { yield envelope; })();

describe('staging batch graceful stop', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('stops before the first scan on %s', async signal => {
    const signals = new EventEmitter(); const lines: string[] = []; const calls: string[] = [];
    const stoppedInput = (async function* () { signals.emit(signal); yield envelope; })();
    const status = await cmdFleetStagingInventoryBatch(['--stdin', '--ndjson'], {
      signals, input: stoppedInput, scanner: async root => { calls.push(root); return report(root); },
      output: { log: line => lines.push(line), error: () => {} },
    });
    expect(status).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(calls).toEqual([]);
    expect(lines.map(line => JSON.parse(line))).toEqual([{
      schema: 'fleet.staging-inventory-batch-summary.v1', requested: 2, attempted: 0,
      completed: 0, remaining: 2, complete: false, interrupted: true, signal,
    }]);
    expect(signals.eventNames()).toEqual([]);
  });

  it.each(['--ndjson', '--json', '--text'])('retains the settled result in %s mode', async mode => {
    const signals = new EventEmitter(); const lines: string[] = []; const calls: string[] = [];
    let settle!: (value: Report) => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<Report>(resolve => { settle = resolve; });
    const run = cmdFleetStagingInventoryBatch(['--stdin', ...(mode === '--text' ? [] : [mode])], {
      signals, input: input(), scanner: async root => { calls.push(root); entered(); return pending; },
      output: { log: line => lines.push(line), error: () => {} },
    });
    await started; signals.emit('SIGTERM'); signals.emit('SIGINT'); settle(report('/fake/a'));
    expect(await run).toBe(143); expect(calls).toEqual(['/fake/a']);
    if (mode === '--ndjson') {
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ index: 0, report: { root: '/fake/a' } });
      expect(JSON.parse(lines[1]!)).toMatchObject({ interrupted: true, signal: 'SIGTERM', requested: 2, attempted: 1, completed: 1, remaining: 1, complete: false });
    } else if (mode === '--json') {
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ interrupted: true, signal: 'SIGTERM', requested: 2, attempted: 1, completed: 1, remaining: 1, reports: [{ root: '/fake/a' }] });
    } else {
      expect(lines.join('\n')).toContain('"/fake/a": complete');
      expect(lines.join('\n')).toContain('Interrupted by SIGTERM: 1 attempted, 1 remaining');
    }
    expect(signals.eventNames()).toEqual([]);
  });

  it('isolates sequential invocations and removes listeners on output errors', async () => {
    const signals = new EventEmitter(); const lines: string[] = [];
    const output = { log: (line: string) => lines.push(line), error: () => {} };
    const stoppedInput = (async function* () { signals.emit('SIGINT'); yield envelope; })();
    expect(await cmdFleetStagingInventoryBatch(['--stdin', '--ndjson'], { signals, input: stoppedInput, scanner: async root => report(root), output })).toBe(130);
    lines.length = 0;
    expect(await cmdFleetStagingInventoryBatch(['--stdin', '--ndjson'], { signals, input: input(), scanner: async root => report(root), output })).toBe(0);
    expect(JSON.parse(lines[2]!)).toEqual({ schema: 'fleet.staging-inventory-batch-summary.v1', requested: 2, completed: 2, complete: true });
    await expect(cmdFleetStagingInventoryBatch(['--stdin', '--ndjson'], { signals, input: input(), scanner: async root => report(root), output: { log: () => { throw new Error('output'); }, error: () => {} } })).rejects.toThrow('output');
    expect(signals.eventNames()).toEqual([]);
  });

  it('handles a real process signal through the source CLI while reading stdin', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'fleet', 'staging-inventory-batch', '--stdin', '--ndjson'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    // Hold stdin open until the CLI has loaded and installed its listeners.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(child.kill('SIGINT')).toBe(true);
    child.stdin.end(envelope);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.on('exit', (c, s) => resolve([c, s])));
    expect([code, signal, stderr]).toEqual([130, null, '']);
    expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toMatchObject([{ interrupted: true, signal: 'SIGINT', attempted: 0, remaining: 2 }]);
  }, 10000);
});
