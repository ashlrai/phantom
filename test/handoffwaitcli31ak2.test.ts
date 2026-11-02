import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 });
const exec = promisify(execFile);
const script = resolve('scripts/agent-wait-handoff.mjs');
const job = 'JOB-123';
let dir: string;
let bin: string;
const detail = (state: string) => ({
  schema: 'fleet.job.v1', generatedAt: '2026-10-31T00:00:00.000Z', job, state,
  lane: null, tier: null, model: null, pid: null, launchedAt: null, baseSha: null, branch: null, promptBytes: null,
  publish: state === 'published' ? { prUrl: 'https://example.test/pull/1', autoMerge: true, testLine: null, sensitive: null } : null,
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'missing', bytes: null, tail: [], truncated: false },
  sources: { launch: 'missing', base: 'missing', meta: 'missing', publish: 'missing', log: 'missing' },
});
const notes = (state: string) => ({ v: 1, job, kind: 'notes', state, bytes: state === 'ok' ? 8 : null, truncated: false, text: state === 'ok' ? 'handoff\n' : '' });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'handoff-wait-'));
  bin = join(dir, 'fake-phm');
  await writeFile(bin, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const log = path.join(dir, 'requests');
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const all = fs.readFileSync(log, 'utf8').trim().split('\\n').length;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config'), 'utf8'));
const response = config[Math.min(all - 1, config.length - 1)];
if (response.hang) { fs.writeFileSync(path.join(dir, 'pid'), String(process.pid)); setInterval(() => {}, 1000); }
else { if (response.stderr) process.stderr.write(response.stderr); if (response.raw) process.stdout.write(response.raw); else console.log(JSON.stringify(response.data)); process.exitCode = response.exit || 0; }
`);
  await chmod(bin, 0o755);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function config(value: unknown) { await writeFile(join(dir, 'config'), JSON.stringify(value)); }
async function run(args: string[]) {
  try {
    const out = await exec(process.execPath, [script, ...args], { env: { ...process.env, HOME: dir, FAKE_DIR: dir }, timeout: 30000 });
    return { code: 0, ...out };
  } catch (error) {
    const e = error as Error & { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
async function requests() {
  try { return (await readFile(join(dir, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch { return []; }
}
const args = () => [job, '--phm-bin', bin, '--deadline-ms', '15000', '--interval-ms', '100'];

describe('handoff wait CLI', () => {
  it('validates all arguments before children and serves help offline', async () => {
    for (const argv of [[], ['../bad'], ['JOB\n'], [job, 'OTHER'], [job, '--deadline-ms', '0'], [job, '--interval-ms', '99'], [job, '--phm-bin', bin, '--phm-bin', bin], ['--help', '--bad']]) {
      expect((await run(argv)).code).toBe(2);
    }
    const help = await run(['--help', '--phm-bin', bin]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('node scripts/agent-wait-handoff.mjs JOB_ID');
    expect(await requests()).toEqual([]);
  });

  it('waits for the published state, retrieves notes once and retains the complete projections', async () => {
    const running = { ...detail('running'), publish: detail('published').publish, future: 'preserve' };
    const published = { ...detail('published'), future: { source: 'unknown' } };
    await config([{ data: running }, { data: published }, { data: notes('ok') }]);
    const out = await run(args());
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ schema: 'fleet.handoff.wait.v1', status: 'complete', detail: published, notes: notes('ok'), commands: 3 });
    expect(await requests()).toEqual([
      ['fleet', 'job', job, '--json'], ['fleet', 'job', job, '--json'], ['fleet', 'job', job, '--notes', '--json'],
    ]);
  });

  it.each(['missing', 'unreadable'])('reports published and %s notes separately', async state => {
    await config([{ data: detail('published') }, { data: notes(state), exit: 1, stderr: 'secret=never-print-this' }]);
    const out = await run(args());
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: `notes_${state}`, detail: { state: 'published' }, notes: notes(state), commands: 2 });
    expect(out.stdout + out.stderr).not.toContain('never-print-this');
  });

  it('preserves the last valid evidence and sanitized child failure at the deadline', async () => {
    const unknown = { ...detail('unknown'), extra: 'future evidence' };
    await config([{ data: unknown }, { raw: 'not json', exit: 1, stderr: 'Bearer never-print-this' }]);
    const out = await run([job, '--phm-bin', bin, '--deadline-ms', '5000', '--interval-ms', '100']);
    expect(out.code).toBe(1);
    const result = JSON.parse(out.stdout);
    expect(result).toMatchObject({ status: 'deadline', detail: unknown, error: { stage: 'detail' } });
    expect(['child_failed', 'child_timeout']).toContain(result.error.code);
    expect(out.stdout + out.stderr).not.toContain('never-print-this');
    expect((await requests()).every(request => !request.includes('--notes'))).toBe(true);
  });

  it('reports a malformed notes response without disclosing stderr', async () => {
    await config([{ data: detail('published') }, { raw: 'bad', stderr: 'token=never-print-this' }]);
    const out = await run(args());
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'notes_error', detail: { state: 'published' }, notes: null, error: { stage: 'notes', code: 'invalid_response' } });
    expect(out.stdout + out.stderr).not.toContain('never-print-this');
  });

  it('reports child failure codes without exposing stderr', async () => {
    await config([{ data: detail('published') }, { raw: 'bad', exit: 1, stderr: 'token=never-print-this' }]);
    const out = await run(args());
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'notes_error', error: { stage: 'notes', code: 'child_failed' } });
    expect(out.stdout + out.stderr).not.toContain('never-print-this');
  });

  it('caps child output and reports the limit without printing it', async () => {
    await config([{ data: detail('published') }, { raw: 'x'.repeat(300000) }]);
    const out = await run(args());
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'notes_error', error: { stage: 'notes', code: 'output_limit' } });
    expect(out.stdout.length).toBeLessThan(5000);
  });

  it('kills a hung child on deadline', async () => {
    await config([{ hang: true }]);
    const out = await run([job, '--phm-bin', bin, '--deadline-ms', '3000', '--interval-ms', '100']);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: 'deadline', error: { code: 'child_timeout' }, commands: 1 });
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('kills a hung child and returns cancellation evidence on SIGTERM', async () => {
    await config([{ hang: true }]);
    const child = spawn(process.execPath, [script, ...args()], { env: { ...process.env, HOME: dir, FAKE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    const done = new Promise<number | null>(resolveDone => child.on('close', resolveDone));
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try { pid = Number(await readFile(join(dir, 'pid'), 'utf8')); } catch { await new Promise(r => setTimeout(r, 20)); }
    }
    expect(pid).toBeGreaterThan(0);
    child.kill('SIGTERM');
    expect(await done).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
