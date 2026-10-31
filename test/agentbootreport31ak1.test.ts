import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/agent-boot-report.mjs');
let dir: string, fake: string, log: string;
const fixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const key = args.slice(0, 2).join(' ');
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, pid: process.pid}) + '\\n');
const shapes = {
  'fleet runs': {v: 1, generatedAt: '2026-01-01T00:00:00Z', runsDirPresent: false, sourceState: 'missing', sources: {status: 'missing'}, lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, lanes: [], switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: {pending: [], done: 0}, future: {unknown: true}},
  'fleet workers': {v: 1, generatedAt: '2026-01-01T00:00:00Z', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0},
  'resources ledger': {v: 1, generatedAt: '2026-01-01T00:00:00Z', sources: {status: 'missing', apiSpend: 'missing', jobs: 'missing'}, asOf: null, lanes: [], apiSpend: null, jobsMalformedRows: null},
  'comms bus': {source: 'missing', retainedCount: null, retainedBytes: null, maxMessages: 1024, maxBytes: 1048576, liveCount: null, expiredCount: null}
};
if (process.env.FAKE_MODE === 'hang' && key !== 'fleet runs') setInterval(() => {}, 1000);
else if (process.env.FAKE_MODE === 'fail' && key === 'fleet workers') {
  console.error('credential-SHOULD-NEVER-APPEAR');
  console.log(JSON.stringify({v: 1, sourceState: 'unavailable', workers: [], leaders: [], orchestratorAgents: 0}));
  process.exitCode = 1;
} else if (process.env.FAKE_MODE === 'invalid' && key === 'resources ledger') console.log('not json');
else if (process.env.FAKE_MODE === 'large' && key === 'comms bus') process.stdout.write('x'.repeat(2100000));
else console.log(JSON.stringify(shapes[key]));
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-report-'));
  fake = join(dir, 'fake-phm');
  log = join(dir, 'requests');
  writeFileSync(fake, fixture);
  chmodSync(fake, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[] = [], mode = '') {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, FAKE_LOG: log, FAKE_MODE: mode },
  });
}
function records(): { args: string[]; pid: number }[] {
  return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

describe('agent boot report', () => {
  it('requests the four real JSON commands and preserves their independent shapes', () => {
    const result = run(['--phm-bin', fake]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.v).toBe(1);
    expect(Number.isFinite(Date.parse(report.generatedAt))).toBe(true);
    expect(Object.values(report.results).map((value: any) => value.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report.results.fleetRuns.data.future).toEqual({ unknown: true });
    expect(report.results.fleetWorkers.data.orchestratorAgents).toBe(0);
    expect(report.results.resourceLedger.data.sources.apiSpend).toBe('missing');
    expect(report.results.busStatus.data).toMatchObject({ source: 'missing', retainedCount: null });
    expect(records().map(row => row.args)).toEqual(expect.arrayContaining([
      ['fleet', 'runs', '--json'], ['fleet', 'workers', '--json'],
      ['resources', 'ledger', '--json'], ['comms', 'bus', 'status'],
    ]));
    expect(records()).toHaveLength(4);
  });

  it('retains JSON from a failed child without exposing stderr', () => {
    const result = run(['--phm-bin', fake], 'fail');
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('credential-SHOULD-NEVER-APPEAR');
    const results = JSON.parse(result.stdout).results;
    expect(results.fleetWorkers).toMatchObject({ status: 'error', code: 'exit_nonzero', data: { sourceState: 'unavailable' } });
    expect(results.fleetRuns.status).toBe('ok');
    expect(results.resourceLedger.status).toBe('ok');
    expect(results.busStatus.status).toBe('ok');
  });

  it('bounds output and reports malformed JSON without losing other reads', () => {
    for (const [mode, key, code] of [['invalid', 'resourceLedger', 'invalid_json'], ['large', 'busStatus', 'output_limit']]) {
      const result = run(['--phm-bin', fake], mode);
      expect(result.status).toBe(1);
      const results = JSON.parse(result.stdout).results;
      expect(results[key]).toEqual({ status: 'error', code, data: null });
      expect(results.fleetRuns.status).toBe('ok');
    }
  });

  it('reports missing executables without exposing their paths', () => {
    const result = run(['--phm-bin', join(dir, 'missing')]);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(dir);
    for (const item of Object.values(JSON.parse(result.stdout).results)) {
      expect(item).toEqual({ status: 'error', code: 'spawn_failed', data: null });
    }
  });

  it('checks all arguments before launching anything and provides standalone help', () => {
    for (const args of [['--timeout-ms', '99'], ['--timeout-ms', '60001'], ['--timeout-ms', '1e3'], ['--phm-bin'], ['--bad'], ['--help', '--bad'], ['--phm-bin', fake, '--phm-bin', fake]]) {
      expect(run(args).status).toBe(2);
    }
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('node scripts/agent-boot-report.mjs');
    expect(() => readFileSync(log)).toThrow();
  }, 15000);

  it('enforces an overall deadline and terminates unfinished children', () => {
    const start = Date.now();
    const result = run(['--phm-bin', fake, '--timeout-ms', '3000'], 'hang');
    expect(result.status).toBe(1);
    expect(Date.now() - start).toBeLessThan(10000);
    const results = JSON.parse(result.stdout).results;
    expect(results.fleetRuns.status).toBe('ok');
    for (const key of ['fleetWorkers', 'resourceLedger', 'busStatus']) expect(results[key].code).toBe('timeout');
    for (const row of records()) expect(() => process.kill(row.pid, 0)).toThrow();
  }, 15000);

  it('emits completed evidence on cancellation and terminates unfinished children', async () => {
    const child = spawn(process.execPath, [script, '--phm-bin', fake, '--timeout-ms', '10000'], {
      env: { ...process.env, FAKE_LOG: log, FAKE_MODE: 'hang' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    // Wait for the fast fake to exit and all hanging fakes to start.
    await new Promise<void>((resolveWait, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        try {
          const rows = records();
          const fast = rows.find(row => row.args[1] === 'runs');
          if (rows.length === 4 && fast) {
            try { process.kill(fast.pid, 0); } catch { setTimeout(resolveWait, 500); return; }
          }
        } catch { /* not created yet */ }
        if (Date.now() > deadline) { reject(new Error('children did not start')); return; }
        setTimeout(check, 20);
      };
      check();
    });
    const closed = new Promise<number | null>(resolveClose => child.on('close', resolveClose));
    child.kill('SIGTERM');
    expect(await closed).toBe(143);
    const results = JSON.parse(stdout).results;
    expect(results.fleetRuns.status).toBe('ok');
    for (const key of ['fleetWorkers', 'resourceLedger', 'busStatus']) expect(results[key].code).toBe('cancelled');
    for (const row of records()) expect(() => process.kill(row.pid, 0)).toThrow();
  }, 15000);
});
