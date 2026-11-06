import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGraphContextRun } from '../src/cli/fleet-graph-context-run.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { CONTEXT_END, CONTEXT_START } from '../src/core/fleet/context-worker-run.js';

let root: string, runsDir: string, file: string, out: string, err: string;
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const run = (a: string[]) =>
  cmdFleetGraphContextRun(a, { stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const node = (script: string, ...rest: string[]) => [process.execPath, '-e', script, ...rest];
const capture =
  'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>' +
  'require("fs").writeFileSync(process.argv[1],JSON.stringify({s})))';
const drain = 'process.stdin.resume();process.stdin.on("end",()=>{})';

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
const rows = (s: string, promptText: string) =>
  s.slice((promptText + CONTEXT_START).length, -CONTEXT_END.length).trim().split('\n')
    .map(line => JSON.parse(line) as { jobId: string; kind: string; text: string });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-context-run-'));
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

describe('fleet graph-context-run', () => {
  it('is convention-discovered as fleet graph-context-run without fleet.ts edits', async () => {
    const resolved = resolveFleetSubcommand('graph-context-run');
    expect(resolved).toEqual({ module: './fleet-graph-context-run.js', exportName: 'cmdFleetGraphContextRun' });
    const loaded = (await import('../src/cli/fleet-graph-context-run.js')) as Record<string, unknown>;
    expect(typeof loaded[resolved!.exportName]).toBe('function');
  });

  it('launches ready nodes and pipes real cited upstream output to the downstream stdin', async () => {
    await writeFile(join(runsDir, 'JOB-UP.notes.md'), 'retained upstream notes marker-abc123\n');
    const aCap = join(root, 'a.json'), bCap = join(root, 'b.json');
    await manifest([
      await task('A', node(capture, aCap), undefined),
      { ...(await task('B', node(capture, bCap), ['A'])), snapshot: await snapshot('JOB-B', ['JOB-UP']) },
    ]);
    expect(await run(['--file', file, '--apply'])).toBe(0);
    const result = JSON.parse(out) as { status: string; nodes: { id: string; status: string; exitCode: number | null }[] };
    expect(result.status).toBe('complete');
    expect(result.nodes).toEqual([
      { id: 'A', status: 'success', exitCode: 0 },
      { id: 'B', status: 'success', exitCode: 0 },
    ]);
    expect(Object.keys(result.nodes[0]!).sort()).toEqual(['exitCode', 'id', 'status']);
    const b = JSON.parse(readFileSync(bCap, 'utf8')) as { s: string };
    expect(b.s.startsWith(`Prompt for B\n${CONTEXT_START}`)).toBe(true);
    expect(b.s.endsWith(CONTEXT_END)).toBe(true);
    const cited = rows(b.s, 'Prompt for B\n');
    expect(cited.some(r => r.jobId === 'JOB-UP' && r.kind === 'output' && r.text.includes('marker-abc123'))).toBe(true);
    expect(cited.some(r => r.jobId === 'JOB-B' && r.kind === 'task' && r.text.includes('fixture task for JOB-B'))).toBe(true);
    // No shell and no authority: argv arrived literally, context stayed data.
    expect(err).not.toContain('marker-abc123');
  }, 30000);

  it('blocks a descendant after its prerequisite fails while an independent node still runs', async () => {
    const bCap = join(root, 'b.json'), cCap = join(root, 'c.json');
    await manifest([
      await task('A', node(`${drain};process.exit(7)`)),
      await task('B', node(capture, bCap), ['A']),
      await task('C', node(capture, cCap)),
    ]);
    expect(await run(['--file', file, '--apply'])).toBe(1);
    const result = JSON.parse(out) as { nodes: { id: string; status: string; exitCode: number | null }[] };
    expect(result.nodes.find(n => n.id === 'A')).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(result.nodes.find(n => n.id === 'B')).toMatchObject({ status: 'blocked', exitCode: null });
    expect(result.nodes.find(n => n.id === 'C')).toMatchObject({ status: 'success', exitCode: 0 });
    expect(existsSync(bCap)).toBe(false);
    expect(existsSync(cCap)).toBe(true);
  }, 30000);

  it('preview, cyclic and invalid manifests produce no child effects', async () => {
    const cap = join(root, 'cap.json');
    const base = await task('A', node(capture, cap));
    expect(await run(['--file', await manifest([base])])).toBe(0);
    const preview = JSON.parse(out) as { status: string; nodes: unknown[] };
    expect(preview.status).toBe('preview');
    expect(preview.nodes).toEqual([{ id: 'A', status: 'planned', exitCode: null }]);

    out = '';
    await manifest([{ ...base, id: 'A', dependsOn: ['B'] }, { ...base, id: 'B', dependsOn: ['A'] }]);
    expect(await run(['--file', file, '--apply'])).toBe(2);
    expect((JSON.parse(out) as { status: string }).status).toBe('invalid');

    out = '';
    for (const bad of [
      [base, base],
      [{ ...base, dependsOn: ['NOPE'] }],
      [{ ...base, surprise: true }],
      [{ ...base, snapshot: 'relative/snap.json' }],
      [{ ...base, argv: [] }],
    ]) {
      await manifest(bad);
      expect(await run(['--file', file, '--apply'])).toBe(2);
      expect((JSON.parse(out) as { status: string }).status).toBe('invalid');
      out = '';
    }
    expect(existsSync(cap)).toBe(false);
  }, 30000);

  it('refuses to launch while the runs PAUSE control is active', async () => {
    const cap = join(root, 'cap.json');
    await manifest([await task('A', node(capture, cap))]);
    await writeFile(join(runsDir, 'PAUSE'), '');
    expect(await run(['--file', file, '--apply'])).toBe(1);
    const result = JSON.parse(out) as { nodes: unknown[] };
    expect(result.nodes).toEqual([{ id: 'A', status: 'refused', exitCode: null }]);
    expect(existsSync(cap)).toBe(false);
  }, 30000);

  it('keeps child logs off the JSON stdout', async () => {
    await manifest([await task('A', node(`${drain};console.log("child-marker-zzz")`))]);
    expect(await run(['--file', file, '--apply', '--json'])).toBe(0);
    expect(out).not.toContain('child-marker-zzz');
    expect(JSON.parse(out)).toMatchObject({ status: 'complete' });
    expect(err).toContain('child-marker-zzz');
  }, 30000);

  it('cancellation stops further launches and cleans up signal listeners', async () => {
    const started = join(root, 'started'), bCap = join(root, 'b.json');
    await manifest([
      await task('A', node(`require("fs").writeFileSync(process.argv[1],"x");${drain};setInterval(()=>{},1000)`, started)),
      await task('B', node(capture, bCap)),
    ]);
    const before = process.listenerCount('SIGINT');
    const running = run(['--file', file, '--apply']);
    // Emit only once the child is up: the worker's own signal handlers are then
    // installed, so the interrupt propagates through the existing runner path.
    for (let i = 0; i < 500 && !existsSync(started); i++) await new Promise(r => setTimeout(r, 10));
    expect(existsSync(started)).toBe(true);
    process.emit('SIGINT');
    expect(await running).toBe(1);
    const result = JSON.parse(out) as { nodes: { status: string; exitCode: number | null }[] };
    expect(result.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled']);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(existsSync(bCap)).toBe(false);
  }, 30000);
});
