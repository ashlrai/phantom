import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cmdFleetGraphRun } from '../src/cli/fleet-graph-run.js';

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-stream-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
const argv = (code: string) => [process.execPath, '-e', code];
const markerCode = (name: string) => `require('node:fs').writeFileSync(${JSON.stringify(join(dir, name))}, 'ok')`;
function manifest(tasks: unknown[]): string {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}
function command(args: string[]) {
  return spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), 'fleet', 'graph-run', ...args], {
    env: { ...process.env, ASHLR_RUNS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function commandSync(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), 'fleet', 'graph-run', ...args], {
    env: { ...process.env, ASHLR_RUNS_DIR: dir }, encoding: 'utf8', timeout: 20000,
  });
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for graph');
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

it('streams a predecessor while its dependent is still running, then one final summary', async () => {
  const release = join(dir, 'release');
  const file = manifest([
    { id: 'first', argv: argv("console.log('child log')") },
    { id: 'later', dependsOn: ['first'], argv: argv(`${markerCode('started')};const t=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))clearInterval(t)},10)`) },
  ]);
  const child = command(['--file', file, '--apply', '--stream']);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<number | null>(resolveClose => child.on('close', resolveClose));
  try {
    await until(() => stdout.includes('\n') && existsSync(join(dir, 'started')));
    expect(child.exitCode).toBeNull();
    expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { version: 1, type: 'node-terminal', node: { id: 'first', status: 'success', exitCode: 0 } },
    ]);
  } finally { writeFileSync(release, ''); }
  expect(await closed).toBe(0);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events).toEqual([
    { version: 1, type: 'node-terminal', node: { id: 'first', status: 'success', exitCode: 0 } },
    { version: 1, type: 'node-terminal', node: { id: 'later', status: 'success', exitCode: 0 } },
    { version: 1, type: 'summary', result: { status: 'complete', nodes: [
      { id: 'first', status: 'success', exitCode: 0 }, { id: 'later', status: 'success', exitCode: 0 },
    ] } },
  ]);
  expect(stderr).toContain('child log');
}, 30000);

it('reports failures and blocked descendants with a failing exit code', () => {
  const file = manifest([
    { id: 'first', argv: argv('process.exit(7)') },
    { id: 'later', dependsOn: ['first'], argv: argv(markerCode('spawned')) },
  ]);
  const run = commandSync(['--file', file, '--apply', '--stream']);
  expect(run.status).toBe(1);
  const events = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(event => event.type)).toEqual(['node-terminal', 'node-terminal', 'summary']);
  expect(events[0].node).toEqual({ id: 'first', status: 'failed', exitCode: 7 });
  expect(events[1].node).toEqual({ id: 'later', status: 'blocked', exitCode: null });
  expect(events[2].result.status).toBe('failed');
  expect(existsSync(join(dir, 'spawned'))).toBe(false);
}, 30000);

it('previews without spawning, preserves ordinary JSON, and rejects malformed flags before spawn', () => {
  const file = manifest([{ id: 'first', argv: argv(markerCode('spawned')) }]);
  const preview = commandSync(['--file', file, '--stream']);
  expect(preview.status).toBe(0);
  const result = { status: 'preview', nodes: [{ id: 'first', status: 'planned', exitCode: null }] };
  expect(preview.stdout).toBe(`${JSON.stringify({ version: 1, type: 'preview', result })}\n`);
  const ordinary = commandSync(['--file', file, '--json']);
  expect(ordinary.status).toBe(0);
  expect(ordinary.stdout).toBe(`${JSON.stringify(result)}\n`);
  for (const flags of [['--stream', '--stream'], ['--stream', '--concurrency', '9'], ['--stream', '--unknown']]) {
    const invalid = commandSync(['--file', file, '--apply', ...flags]);
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe('');
  }
  expect(existsSync(join(dir, 'spawned'))).toBe(false);
}, 30000);

it('waits for the output write before starting a dependent', async () => {
  const file = manifest([
    { id: 'first', argv: argv('') },
    { id: 'later', dependsOn: ['first'], argv: argv(markerCode('spawned')) },
  ]);
  let release: (() => void) | undefined;
  let writes = 0;
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
    if (++writes === 1) release = () => callback();
    else callback();
  } });
  const run = cmdFleetGraphRun(['--file', file, '--apply', '--stream'], output);
  try {
    await until(() => release !== undefined);
    expect(existsSync(join(dir, 'spawned'))).toBe(false);
  } finally { release?.(); }
  expect(await run).toBe(0);
  expect(existsSync(join(dir, 'spawned'))).toBe(true);
}, 30000);

it('handles writable failure and does not start newly unblocked work', async () => {
  const file = manifest([
    { id: 'first', argv: argv('') },
    { id: 'later', dependsOn: ['first'], argv: argv(markerCode('spawned')) },
  ]);
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(Error('fixture output failure')); } });
  expect(await cmdFleetGraphRun(['--file', file, '--apply', '--stream'], output)).toBe(1);
  await new Promise(resolveWait => setImmediate(resolveWait));
  expect(existsSync(join(dir, 'spawned'))).toBe(false);
}, 30000);
