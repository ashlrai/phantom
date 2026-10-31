import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/agent-artifact-pack.mjs');
let dir: string;
let bin: string;
let log: string;
const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'fleet') {
  const job = args[2];
  if (job === 'HANG') { fs.writeFileSync(process.env.FAKE_PID, String(process.pid)); setInterval(() => {}, 1000); return; }
  if (job === 'FLOOD') { process.stdout.write('x'.repeat(600000)); return; }
  if (job === 'BAD') { process.stderr.write('Bearer secret-token'); process.stdout.write('{'); process.exitCode = 1; return; }
  const state = job === 'MISSING' ? 'missing' : job === 'UNREADABLE' ? 'unreadable' : job === 'FUTURE' ? 'future_state' : 'ok';
  console.log(JSON.stringify({v:1, job, kind:'notes', state, bytes:state === 'ok' ? 12 : null, truncated:job === 'TRUNCATED', text:state === 'ok' ? 'notes ' + job : ''}));
  if (state !== 'ok') process.exitCode = 1;
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const snapshot = JSON.parse(input);
    fs.writeFileSync(process.env.FAKE_SNAPSHOT, input);
    const pack = snapshot.outputs.map(row => JSON.stringify({jobId:row.jobId, kind:'output', text:row.text, truncated:false}) + '\\n').join('');
    console.log(JSON.stringify({v:1, jobId:snapshot.node.jobId, pack, bytes:Buffer.byteLength(pack), report:{requestedByteBudget:snapshot.byteBudget, emittedBytes:Buffer.byteLength(pack), emittedRecordCount:snapshot.outputs.length, citedJobIds:snapshot.outputs.map(row=>row.jobId), truncatedRecordCount:0, fairUpstreamMissingOutputJobIds:[]}}));
  });
}
`;
function env() { return { ...process.env, FAKE_LOG: log, FAKE_PID: join(dir, 'pid'), FAKE_SNAPSHOT: join(dir, 'snapshot') }; }
function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: env(), timeout: 30000 });
}
function calls() { try { return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } }
const base = () => ['--job', 'NEXT', '--phm-bin', bin];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-pack-'));
  bin = join(dir, 'fake-phm'); log = join(dir, 'calls');
  writeFileSync(bin, fixture, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('artifact pack CLI', () => {
  it('requests the real CLI shapes and emits the pack with source states', () => {
    const result = run(...base(), '--upstream', 'FIRST', '--upstream', 'TRUNCATED', '--byte-budget', '8192');
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.acquisition).toEqual([
      { jobId: 'FIRST', state: 'ok', bytes: 12, truncated: false },
      { jobId: 'TRUNCATED', state: 'ok', bytes: 12, truncated: true },
    ]);
    expect(output.pack).toContain('notes FIRST');
    expect(output.bytes).toBe(Buffer.byteLength(output.pack));
    expect(calls()).toEqual([
      ['fleet', 'job', 'FIRST', '--notes', '--json'], ['fleet', 'job', 'TRUNCATED', '--notes', '--json'],
      ['knowledge', 'context-pack', '--stdin', '--json', '--report', '--fair-upstream'],
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'snapshot'), 'utf8'))).toEqual({
      node: { jobId: 'NEXT', upstreamJobIds: ['FIRST', 'TRUNCATED'] }, tasks: [],
      outputs: [{ jobId: 'FIRST', text: 'notes FIRST' }, { jobId: 'TRUNCATED', text: 'notes TRUNCATED' }], byteBudget: 8192,
    });
  });

  it('reports missing, unreadable, unknown, malformed and excessive evidence without leaking stderr', () => {
    const result = run(...base(), ...['FIRST', 'MISSING', 'UNREADABLE', 'FUTURE', 'BAD', 'FLOOD'].flatMap(id => ['--upstream', id]));
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('secret-token');
    const output = JSON.parse(result.stdout);
    expect(output.pack).toContain('notes FIRST');
    expect(output.acquisition.map((entry: { state: string; code?: string }) => [entry.state, entry.code])).toEqual([
      ['ok', undefined], ['missing', 'missing'], ['unreadable', 'unreadable'], ['future_state', 'unknown_state'],
      ['unknown', 'invalid_response'], ['unknown', 'output_limit'],
    ]);
  }, 15000);

  it('reports a packer failure and never emits child stderr', () => {
    const result = run('--job', 'NEXT', '--upstream', 'FIRST', '--phm-bin', join(dir, 'absent'));
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.acquisition[0].code).toBe('spawn_failed');
    expect(output.error).toBe('spawn_failed');
  });

  it('prints the invocation in help without launching a child', () => {
    const result = run('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node scripts/agent-artifact-pack.mjs --job');
    expect(calls()).toEqual([]);
  });

  it.each([
    [], ['--job', 'NEXT'], ['--job', 'a', '--upstream', 'FIRST'],
    ['--job', 'NEXT', '--upstream', 'NEXT'], ['--job', 'NEXT', '--upstream', 'FIRST', '--upstream', 'FIRST'],
    ['--job', 'NEXT', '--upstream', 'FIRST', '--byte-budget', '65537'],
    ['--job', 'NEXT', '--upstream', 'FIRST', '--byte-budget', '1.5'],
    ['--job', 'NEXT', '--upstream', 'FIRST', '--phm-bin'],
    ['--job', 'NEXT', ...Array.from({ length: 21 }, (_, i) => ['--upstream', `ID${i}`]).flat()],
  ])('rejects invalid arguments before starting a child: %j', (...args) => {
    expect(run(...args).status).toBe(2);
    expect(calls()).toEqual([]);
  });

  it('reports a deadline and reaps the timed-out child', () => {
    const result = run(...base(), '--upstream', 'HANG');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).acquisition[0].code).toBe('timeout');
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);

  it('cancels and reaps an active child on SIGTERM', async () => {
    const proc = spawn(process.execPath, [script, ...base(), '--upstream', 'HANG'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.setEncoding('utf8'); proc.stdout.on('data', chunk => stdout += chunk);
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('child did not start')); }, 2000);
      const check = setInterval(() => {
        try { readFileSync(join(dir, 'pid')); clearTimeout(timer); clearInterval(check); resolveReady(); } catch { /* wait for fixture */ }
      }, 20);
    });
    const done = new Promise<number | null>(resolveClose => proc.on('close', resolveClose));
    proc.kill('SIGTERM');
    expect(await done).toBe(130);
    expect(JSON.parse(stdout).error).toBe('cancelled');
    expect(() => process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 0)).toThrow();
  });
});
