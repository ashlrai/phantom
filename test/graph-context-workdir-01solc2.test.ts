import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { graphContextRun } from '../src/core/fleet/graph-context-run.js';
import { CONTEXT_START, CONTEXT_END } from '../src/core/fleet/context-worker-run.js';

let root: string, runsDir: string, file: string, err: string;
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = { stderr: sink(s => { err += s; }) };
const node = (script: string, ...rest: string[]) => [process.execPath, '-e', script, ...rest];
// Every child must drain the cited pack on stdin before acting.
const end = (body: string) =>
  `const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{${body}})`;
const record = end('fs.writeFileSync(process.argv[1],process.cwd());fs.writeFileSync(process.argv[2],s)');
const marker = (name: string) => join(root, name);
const CITED_A = 'cited pack alpha marker zq9';
const CITED_B = 'cited pack beta marker k4r';

const snapshot = async (jobId: string, cited: string): Promise<string> => {
  const path = join(root, `snapshot-${jobId}.json`);
  await writeFile(path, JSON.stringify({
    node: { jobId, upstreamJobIds: [`UP-${jobId}`] },
    tasks: [{ jobId: `UP-${jobId}`, text: cited }],
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
const task = async (id: string, argv: string[], extra: { cwd?: string; dependsOn?: string[]; cited?: string } = {}): Promise<Record<string, unknown>> =>
  ({ id, snapshot: await snapshot(`JOB-${id}`, extra.cited ?? `cited ${id}`), prompt: await prompt(id), argv,
    ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}), ...(extra.cwd !== undefined ? { cwd: extra.cwd } : {}) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-context-workdir-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  runsDir = join(root, '.ashlr-runs');
  file = join(root, 'manifest.json');
  err = '';
  await mkdir(runsDir, { mode: 0o700 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('fleet graph-context-run per-task cwd', () => {
  it('runs two nodes in their caller-selected checkouts in parallel, each with its own cited pack', async () => {
    const dirA = join(root, 'checkout A $(phony);[x]'), dirB = join(root, 'checkout B');
    await mkdir(dirA); await mkdir(dirB);
    // Rendezvous: each child drops its marker and exits only once the peer's
    // exists — impossible unless both run at the same time. On success each
    // records its own working directory and everything it read on stdin.
    const rendezvous = end(
      'fs.writeFileSync(process.argv[1],"ok");' +
      'const deadline=Date.now()+20000;const t=setInterval(()=>{' +
      'if(fs.existsSync(process.argv[2])){clearInterval(t);' +
      'fs.writeFileSync(process.argv[3],process.cwd());fs.writeFileSync(process.argv[4],s);process.exit(0)}' +
      'if(Date.now()>deadline){clearInterval(t);process.exit(9)}},10);');
    const a = { up: marker('a.up'), cwd: marker('a-cwd'), stdin: marker('a-stdin') };
    const b = { up: marker('b.up'), cwd: marker('b-cwd'), stdin: marker('b-stdin') };
    const before = process.cwd();
    await manifest([
      await task('A', node(rendezvous, a.up, b.up, a.cwd, a.stdin), { cwd: dirA, cited: CITED_A }),
      await task('B', node(rendezvous, b.up, a.up, b.cwd, b.stdin), { cwd: dirB, cited: CITED_B }),
    ]);
    expect(await graphContextRun(file, true, io, 2)).toEqual({ status: 'complete', nodes: [
      { id: 'A', status: 'success', exitCode: 0 },
      { id: 'B', status: 'success', exitCode: 0 },
    ] });
    expect(await readFile(a.cwd, 'utf8')).toBe(realpathSync(dirA));
    expect(await readFile(b.cwd, 'utf8')).toBe(realpathSync(dirB));
    const stdinA = await readFile(a.stdin, 'utf8'), stdinB = await readFile(b.stdin, 'utf8');
    expect(stdinA.startsWith(`Prompt for A\n${CONTEXT_START}`)).toBe(true);
    expect(stdinB.startsWith(`Prompt for B\n${CONTEXT_START}`)).toBe(true);
    expect(stdinA).toContain(CITED_A); expect(stdinA).not.toContain(CITED_B);
    expect(stdinB).toContain(CITED_B); expect(stdinB).not.toContain(CITED_A);
    expect(stdinA.endsWith(CONTEXT_END)).toBe(true);
    expect(process.cwd()).toBe(before);
  });

  it.each([
    ['a relative directory', () => 'relative/dir'],
    ['an empty string', () => ''],
    ['a NUL byte', () => 'bad\0dir'],
    ['a null value', () => null as unknown as string],
    ['a non-string value', () => 42 as unknown as string],
    ['a missing directory', () => join(root, 'missing')],
    ['a regular file', () => file],
  ])('rejects the whole graph when any node has cwd of %s, in preview and apply', async (_label, cwd) => {
    const cap = marker('cap.json');
    const touch = end('fs.writeFileSync(process.argv[1],process.cwd())');
    await manifest([
      await task('A', node(touch, cap)),
      { ...(await task('B', node(touch, marker('b.json')))), cwd: cwd() },
    ]);
    // The bad cwd sits on an independent node: only whole-manifest validation
    // before admission can explain A never launching.
    expect((await graphContextRun(file, false, io, 2)).status).toBe('invalid');
    expect((await graphContextRun(file, true, io, 2)).status).toBe('invalid');
    expect(existsSync(cap)).toBe(false);
    expect(existsSync(marker('b.json'))).toBe(false);
  });

  it('preview plans the full order and launches nothing even with valid cwd', async () => {
    const dir = join(root, 'checkout');
    await mkdir(dir);
    const cap = marker('cap.json');
    await manifest([
      await task('A', node(end('fs.writeFileSync(process.argv[1],"x")'), cap), { cwd: dir }),
      await task('B', node(end('fs.writeFileSync(process.argv[1],"x")'), marker('b.json')), { cwd: dir, dependsOn: ['A'] }),
    ]);
    expect(await graphContextRun(file, false, io, 4)).toEqual({ status: 'preview', nodes: [
      { id: 'A', status: 'planned', exitCode: null },
      { id: 'B', status: 'planned', exitCode: null },
    ] });
    expect(existsSync(cap)).toBe(false);
    expect(err).toBe('');
  });

  it('keeps the runner working directory for nodes that omit cwd and never derives one from cited content', async () => {
    const rec = { cwd: marker('cwd'), stdin: marker('stdin') };
    // The cited text deliberately carries an absolute-path-looking string; a
    // node without cwd must still run in the runner's own directory.
    await manifest([await task('A', node(record, rec.cwd, rec.stdin),
      { cited: `checkout hint ${join(root, 'decoy')} ${CITED_A}` })]);
    expect((await graphContextRun(file, true, io)).status).toBe('complete');
    expect(await readFile(rec.cwd, 'utf8')).toBe(process.cwd());
    const stdin = await readFile(rec.stdin, 'utf8');
    expect(stdin).toContain(CITED_A);
    expect(existsSync(join(root, 'decoy'))).toBe(false);
  });

  it('runs a dependent in its own cwd only after the prerequisite finishes', async () => {
    const dirA = join(root, 'co-a'), dirB = join(root, 'co-b');
    await mkdir(dirA); await mkdir(dirB);
    // Relative writes resolve inside each node's own checkout: A leaves
    // proof.txt in dirA; B must not find it in dirB and drops its own there.
    const aProof = join(dirA, 'proof.txt');
    await manifest([
      await task('A', node(end('fs.writeFileSync("proof.txt",process.cwd())')), { cwd: dirA }),
      await task('B', node(end(
        'if(!fs.existsSync(process.argv[1]))process.exit(7);' +
        'if(fs.existsSync("proof.txt"))process.exit(8);' +
        'fs.writeFileSync("proof.txt",process.cwd())'), aProof), { cwd: dirB, dependsOn: ['A'] }),
    ]);
    const before = process.cwd();
    expect(await graphContextRun(file, true, io, 2)).toEqual({ status: 'complete', nodes: [
      { id: 'A', status: 'success', exitCode: 0 },
      { id: 'B', status: 'success', exitCode: 0 },
    ] });
    expect(await readFile(join(dirA, 'proof.txt'), 'utf8')).toBe(realpathSync(dirA));
    expect(await readFile(join(dirB, 'proof.txt'), 'utf8')).toBe(realpathSync(dirB));
    expect(existsSync(join(root, 'proof.txt'))).toBe(false);
    expect(process.cwd()).toBe(before);
  });

  it('refuses cwd-bearing nodes while a runs control is active', async () => {
    const dir = join(root, 'co');
    await mkdir(dir);
    await manifest([
      await task('A', node(end('fs.writeFileSync(process.argv[1],"x")'), marker('a.json')), { cwd: dir }),
      await task('B', node(end('fs.writeFileSync(process.argv[1],"x")'), marker('b.json'))),
    ]);
    await writeFile(join(runsDir, 'PAUSE'), '');
    expect(await graphContextRun(file, true, io, 2)).toEqual({ status: 'failed', nodes: [
      { id: 'A', status: 'refused', exitCode: null },
      { id: 'B', status: 'refused', exitCode: null },
    ] });
    expect(existsSync(marker('a.json'))).toBe(false);
    expect(existsSync(marker('b.json'))).toBe(false);
  });

  it('blocks a cwd-bearing descendant when its prerequisite fails', async () => {
    const dir = join(root, 'co');
    await mkdir(dir);
    await manifest([
      await task('A', node(end('process.exit(7)'))),
      await task('B', node(end('fs.writeFileSync(process.argv[1],"x")'), marker('b.json')), { cwd: dir, dependsOn: ['A'] }),
    ]);
    expect(await graphContextRun(file, true, io, 2)).toEqual({ status: 'failed', nodes: [
      { id: 'A', status: 'failed', exitCode: 7 },
      { id: 'B', status: 'blocked', exitCode: null },
    ] });
    expect(existsSync(marker('b.json'))).toBe(false);
  });
});
