import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { cmdFleetGraphContextRun } from '../src/cli/fleet-graph-context-run.js';
import { graphContextRun } from '../src/core/fleet/graph-context-run.js';
import { CONTEXT_START } from '../src/core/fleet/context-worker-run.js';

let root: string, runsDir: string, file: string, out: string, err: string;
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const run = (a: string[]) =>
  cmdFleetGraphContextRun(a, { stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const io = { stderr: sink(s => { err += s; }) };
const node = (script: string, ...rest: string[]) => [process.execPath, '-e', script, ...rest];
// Every child must drain the cited pack on stdin before acting.
const end = (body: string) =>
  `const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{${body}})`;
const capture = (arg: number) => end(`fs.writeFileSync(process.argv[${arg}],JSON.stringify({s}))`);
const marker = (name: string) => join(root, name);
const literal = (name: string) => JSON.stringify(marker(name));

const snapshot = async (jobId: string, upstreamJobIds: string[] = []): Promise<string> => {
  const path = join(root, `snapshot-${jobId}.json`);
  await writeFile(path, JSON.stringify({
    node: { jobId, upstreamJobIds },
    tasks: [{ jobId, text: `fixture task for ${jobId}` }],
    outputs: [], byteBudget: 8192,
  }));
  return path;
};
const prompt = async (id: string): Promise<string> => {
  const path = join(root, `prompt-${id}.txt`);
  await writeFile(path, `Prompt for ${id}\n`);
  return path;
};
const manifest = async (tasks: unknown[]): Promise<string> => {
  await writeFile(file, JSON.stringify({ version: 1, tasks }));
  return file;
};
const task = async (id: string, argv: string[], dependsOn?: string[]): Promise<Record<string, unknown>> =>
  ({ id, dependsOn, snapshot: await snapshot(`JOB-${id}`), prompt: await prompt(id), argv });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-context-concurrency-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  runsDir = join(root, '.ashlr-runs');
  file = join(root, 'manifest.json');
  out = ''; err = '';
  await mkdir(runsDir, { mode: 0o700 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('fleet graph-context-run concurrency', () => {
  it('overlaps two independent real node children at --concurrency 2', async () => {
    // Rendezvous: each child drops its own marker and exits 0 only once the
    // peer's marker exists — impossible unless both run at the same time.
    const rendezvous = end(
      'fs.writeFileSync(process.argv[1],"ok");' +
      'const deadline=Date.now()+20000;const t=setInterval(()=>{' +
      'if(fs.existsSync(process.argv[2])){clearInterval(t);process.exit(0)}' +
      'if(Date.now()>deadline){clearInterval(t);process.exit(9)}},10);');
    await manifest([
      await task('A', node(rendezvous, marker('a.up'), marker('b.up'))),
      await task('B', node(rendezvous, marker('b.up'), marker('a.up'))),
    ]);
    expect(await run(['--file', file, '--apply', '--concurrency', '2'])).toBe(0);
    const result = JSON.parse(out) as { status: string; nodes: { id: string; status: string; exitCode: number | null }[] };
    expect(result.status).toBe('complete');
    expect(result.nodes).toEqual([
      { id: 'A', status: 'success', exitCode: 0 },
      { id: 'B', status: 'success', exitCode: 0 },
    ]);
  });

  it('launches a dependent child only after both prerequisite markers exist', async () => {
    await manifest([
      await task('A', node(end('fs.writeFileSync(process.argv[1],"ok")'), marker('a.up'))),
      await task('B', node(end('setTimeout(()=>{fs.writeFileSync(process.argv[1],"ok");process.exit(0)},400)'), marker('b.up'))),
      await task('C', node(end(
        'if(!fs.existsSync(process.argv[1])||!fs.existsSync(process.argv[2]))process.exit(7);' +
        'fs.writeFileSync(process.argv[3],JSON.stringify({s}))'),
        marker('a.up'), marker('b.up'), marker('c.json')), ['A', 'B']),
    ]);
    expect(await run(['--file', file, '--apply', '--concurrency', '2'])).toBe(0);
    const result = JSON.parse(out) as { nodes: { id: string; status: string; exitCode: number | null }[] };
    expect(result.nodes).toEqual([
      { id: 'A', status: 'success', exitCode: 0 },
      { id: 'B', status: 'success', exitCode: 0 },
      { id: 'C', status: 'success', exitCode: 0 },
    ]);
    const c = JSON.parse(readFileSync(marker('c.json'), 'utf8')) as { s: string };
    expect(c.s.startsWith(`Prompt for C\n${CONTEXT_START}`)).toBe(true);
  });

  it('blocks only descendants of a failed node and preserves topological result order', async () => {
    await manifest([
      await task('A', node(end('process.exit(7)'))),
      await task('B', node(capture(1), marker('b.json')), ['A']),
      await task('C', node(capture(1), marker('c.json'))),
      await task('D', node(capture(1), marker('d.json')), ['B']),
    ]);
    expect(await run(['--file', file, '--apply', '--concurrency', '2'])).toBe(1);
    const result = JSON.parse(out) as { nodes: { id: string; status: string; exitCode: number | null }[] };
    expect(result.nodes).toEqual([
      { id: 'A', status: 'failed', exitCode: 7 },
      { id: 'C', status: 'success', exitCode: 0 },
      { id: 'B', status: 'blocked', exitCode: null },
      { id: 'D', status: 'blocked', exitCode: null },
    ]);
    expect(existsSync(marker('b.json'))).toBe(false);
    expect(existsSync(marker('d.json'))).toBe(false);
    expect(existsSync(marker('c.json'))).toBe(true);
  });

  it('preserves strictly sequential behavior at --concurrency 1 and by default', async () => {
    const log = literal('seq.log');
    const a = end(`fs.appendFileSync(${log},"A-start\\n");` +
      `setTimeout(()=>{fs.appendFileSync(${log},"A-end\\n");process.exit(0)},400)`);
    const b = end(`if(!fs.existsSync(${log})||!fs.readFileSync(${log},"utf8").includes("A-end"))process.exit(3);`);
    for (const extra of [['--concurrency', '1'], []]) {
      await rm(marker('seq.log'), { force: true });
      await manifest([await task('A', node(a)), await task('B', node(b))]);
      expect(await run(['--file', file, '--apply', ...extra])).toBe(0);
      expect((JSON.parse(out) as { nodes: { status: string }[] }).nodes.map(n => n.status)).toEqual(['success', 'success']);
      out = '';
    }
    await rm(marker('seq.log'), { force: true });
    expect((await graphContextRun(file, true, io)).status).toBe('complete');
  });

  it('rejects invalid concurrency values and invalid manifests without launching', async () => {
    const cap = marker('cap.json');
    await manifest([await task('A', node(capture(1), cap))]);
    for (const value of ['0', '9', '1.5', '-1', 'x']) {
      expect(await run(['--file', file, '--apply', '--concurrency', value])).toBe(2);
      out = '';
    }
    expect(await run(['--file', file, '--apply', '--concurrency'])).toBe(2);
    expect(await run(['--file', file, '--concurrency', '2', '--concurrency', '2'])).toBe(2);
    for (const bad of [0, 9, 2.5, Number.NaN]) {
      expect((await graphContextRun(file, true, io, bad)).status).toBe('invalid');
    }
    const base = await task('X', node(capture(1), cap));
    await manifest([{ ...base, id: 'X', dependsOn: ['Y'] }, { ...base, id: 'Y', dependsOn: ['X'] }]);
    expect(await run(['--file', file, '--apply', '--concurrency', '4'])).toBe(2);
    expect((JSON.parse(out) as { status: string }).status).toBe('invalid');
    expect(existsSync(cap)).toBe(false);
  });

  it('preview plans the full order and stays side-effect-free at any concurrency', async () => {
    const cap = marker('cap.json');
    await manifest([
      await task('A', node(capture(1), cap)),
      await task('B', node(capture(1), marker('b.json')), ['A']),
    ]);
    expect(await run(['--file', file, '--concurrency', '4'])).toBe(0);
    const result = JSON.parse(out) as { status: string; nodes: unknown[] };
    expect(result).toEqual({ status: 'preview', nodes: [
      { id: 'A', status: 'planned', exitCode: null },
      { id: 'B', status: 'planned', exitCode: null },
    ] });
    expect(existsSync(cap)).toBe(false);
    expect(err).toBe('');
  });

  it('refuses every queued launch while a runs control is active', async () => {
    await manifest([
      await task('A', node(capture(1), marker('a.json'))),
      await task('B', node(capture(1), marker('b.json'))),
    ]);
    await writeFile(join(runsDir, 'PAUSE'), '');
    expect(await run(['--file', file, '--apply', '--concurrency', '2'])).toBe(1);
    const result = JSON.parse(out) as { nodes: { id: string; status: string; exitCode: number | null }[] };
    expect(result.nodes).toEqual([
      { id: 'A', status: 'refused', exitCode: null },
      { id: 'B', status: 'refused', exitCode: null },
    ]);
    expect(existsSync(marker('a.json'))).toBe(false);
    expect(existsSync(marker('b.json'))).toBe(false);
  });

  it('stops admission on cancellation, cancels queued rows and restores listeners', async () => {
    const hanging = end('fs.writeFileSync(process.argv[1],"x");setInterval(()=>{},1000)');
    await manifest([
      await task('A', node(hanging, marker('started-A'))),
      await task('B', node(hanging, marker('started-B'))),
      await task('C', node(capture(1), marker('c.json'))),
    ]);
    const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    const running = run(['--file', file, '--apply', '--concurrency', '2']);
    // Both children must be up so each worker's own signal handlers forward the interrupt.
    for (let i = 0; i < 1000 && !(existsSync(marker('started-A')) && existsSync(marker('started-B'))); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(existsSync(marker('started-A'))).toBe(true);
    expect(existsSync(marker('started-B'))).toBe(true);
    process.emit('SIGINT');
    expect(await running).toBe(1);
    const result = JSON.parse(out) as { nodes: { id: string; status: string }[] };
    expect(result.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(existsSync(marker('c.json'))).toBe(false);
    expect(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s))).toEqual(before);
  });
});
