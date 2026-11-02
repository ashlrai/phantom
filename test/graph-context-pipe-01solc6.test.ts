import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGraphContextPipe } from '../src/cli/fleet-graph-context-pipe.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { CONTEXT_END, CONTEXT_START } from '../src/core/fleet/context-worker-run.js';

let root: string, stage: string, runsDir: string;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-context-pipe-'));
  stage = join(root, 'stage');
  runsDir = join(root, '.ashlr-runs');
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  await mkdir(stage, { mode: 0o700 });
  await mkdir(runsDir, { mode: 0o700 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const manifest = (tasks: unknown[]) => Buffer.from(JSON.stringify({ version: 1, tasks }));
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
const prompt = async (id: string, text = `Prompt for ${id}\n`): Promise<string> => {
  const path = join(root, `prompt-${id}.txt`);
  await writeFile(path, text);
  return path;
};
const task = async (id: string, argv: string[], dependsOn?: string[]): Promise<Record<string, unknown>> =>
  ({ id, ...(dependsOn ? { dependsOn } : {}), snapshot: await snapshot(`JOB-${id}`), prompt: await prompt(id), argv });

function invoke(input: Readable, args: string[] = ['--stdin']) {
  const lines: string[] = [];
  let err = '';
  const done = cmdFleetGraphContextPipe(args, {
    stdin: input as Readable & { isTTY?: boolean },
    tempRoot: stage,
    stderr: sink(s => { err += s; }),
    output: line => lines.push(line),
  });
  return { done, lines, err: () => err };
}
const staged = () => readdirSync(stage).filter(name => name.startsWith('phantom-graph-context-pipe-'));

describe('fleet graph-context-pipe', () => {
  it('is convention-discovered as fleet graph-context-pipe without fleet.ts edits', async () => {
    const resolved = resolveFleetSubcommand('graph-context-pipe');
    expect(resolved).toEqual({ module: './fleet-graph-context-pipe.js', exportName: 'cmdFleetGraphContextPipe' });
    const loaded = (await import('../src/cli/fleet-graph-context-pipe.js')) as Record<string, unknown>;
    expect(typeof loaded[resolved!.exportName]).toBe('function');
  });

  it('previews a piped context graph without launching or retaining staging', async () => {
    const cap = join(root, 'cap.json');
    const bytes = manifest([await task('A', node(capture, cap))]);
    const { done, lines } = invoke(Readable.from([bytes]), ['--stdin', '--json']);
    expect(await done).toBe(0);
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!) as { status: string; nodes: unknown[] };
    expect(result.status).toBe('preview');
    expect(result.nodes).toEqual([{ id: 'A', status: 'planned', exitCode: null }]);
    expect(existsSync(cap)).toBe(false);
    expect(staged()).toEqual([]);
  });

  it('applies a piped graph and delivers the cited context pack to worker stdin', async () => {
    await writeFile(join(runsDir, 'JOB-UP.notes.md'), 'retained upstream notes marker-abc123\n');
    const aCap = join(root, 'a.json'), bCap = join(root, 'b.json');
    const bytes = manifest([
      await task('A', node(capture, aCap)),
      { ...(await task('B', node(capture, bCap), ['A'])), snapshot: await snapshot('JOB-B', ['JOB-UP']) },
    ]);
    const { done, lines, err } = invoke(Readable.from([bytes]), ['--stdin', '--apply', '--concurrency', '2', '--json']);
    expect(await done).toBe(0);
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!) as { status: string; nodes: unknown[] };
    expect(result.status).toBe('complete');
    expect(result.nodes).toEqual([
      { id: 'A', status: 'success', exitCode: 0 },
      { id: 'B', status: 'success', exitCode: 0 },
    ]);
    const b = JSON.parse(readFileSync(bCap, 'utf8')) as { s: string };
    expect(b.s.startsWith(`Prompt for B\n${CONTEXT_START}`)).toBe(true);
    expect(b.s.endsWith(CONTEXT_END)).toBe(true);
    expect(b.s).toContain('marker-abc123');
    // The sanitized summary carries only the node rows, never cited or prompt text.
    expect(lines[0]).not.toContain('marker-abc123');
    expect(lines[0]).not.toContain('Prompt for B');
    expect(err()).not.toContain('marker-abc123');
    expect(staged()).toEqual([]);
  }, 30000);

  it('keeps worker output on stderr and the sanitized summary alone on stdout', async () => {
    const bytes = manifest([await task('A', node(`${drain};console.log("child-marker-zzz")`))]);
    const { done, lines, err } = invoke(Readable.from([bytes]), ['--stdin', '--apply', '--json']);
    expect(await done).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('child-marker-zzz');
    expect(JSON.parse(lines[0]!)).toMatchObject({ status: 'complete' });
    expect(err()).toContain('child-marker-zzz');
    expect(staged()).toEqual([]);
  }, 30000);

  it('decodes fragmented multibyte UTF-8 across chunk boundaries', async () => {
    const cap = join(root, 'cap.json');
    const base = await task('A', node(capture, cap));
    const bytes = manifest([{ ...base, argv: [...(base.argv as string[]), 'é'] }]);
    const input = new PassThrough();
    const { done, lines } = invoke(input);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    input.write(bytes.subarray(0, split));
    await sleep(20);
    expect(existsSync(cap)).toBe(false);
    input.end(bytes.subarray(split));
    expect(await done).toBe(0);
    expect(JSON.parse(lines[0]!).status).toBe('preview');
    expect(existsSync(cap)).toBe(false);
    expect(staged()).toEqual([]);
  });

  it('enforces the 256 KiB cap while accepting a boundary-sized document', async () => {
    const over = Buffer.alloc(262145, 32);
    const { done, lines } = invoke(Readable.from([over]), ['--stdin', '--apply']);
    expect(await done).toBe(2);
    const result = JSON.parse(lines[0]!) as { status: string; error?: string };
    expect(result.status).toBe('invalid');
    expect(result.error).toMatch(/256 KiB/);
    expect(staged()).toEqual([]);

    const base = JSON.stringify({ version: 1, tasks: [await task('A', node('process.exit(0)'))] });
    const exact = Buffer.concat([Buffer.from(base), Buffer.alloc(262144 - Buffer.byteLength(base), 32)]);
    expect(exact.length).toBe(262144);
    const ok = invoke(Readable.from([exact]));
    expect(await ok.done).toBe(0);
    expect(JSON.parse(ok.lines[0]!).status).toBe('preview');
    expect(staged()).toEqual([]);
  });

  it('settles early close and stream error without launching', async () => {
    const cap = join(root, 'cap.json');
    const bytes = manifest([await task('A', node(capture, cap))]);
    const closed = new PassThrough();
    const first = invoke(closed, ['--stdin', '--apply']);
    closed.write(bytes.subarray(0, 40));
    closed.destroy();
    expect(await first.done).toBe(1);
    expect(JSON.parse(first.lines[0]!).error).toMatch(/closed before EOF/);

    const errored = new PassThrough();
    const second = invoke(errored, ['--stdin', '--apply']);
    errored.destroy(new Error('boom'));
    expect(await second.done).toBe(1);
    expect(JSON.parse(second.lines[0]!).error).toMatch(/could not read stdin/);
    expect(existsSync(cap)).toBe(false);
    expect(staged()).toEqual([]);
  });

  it('times out a stalled pipe, keeping the input deadline off execution', async () => {
    const input = new PassThrough();
    const before = ['data', 'end', 'error', 'close'].map(event => input.listenerCount(event));
    const signals = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    const { done, lines } = invoke(input, ['--stdin', '--apply', '--input-timeout-ms', '80']);
    input.write(manifest([await task('A', node(capture, join(root, 'cap.json')))]).subarray(0, 40));
    expect(await done).toBe(1);
    expect(JSON.parse(lines[0]!).error).toMatch(/deadline/);
    expect(input.destroyed).toBe(false);
    expect(['data', 'end', 'error', 'close'].map(event => input.listenerCount(event))).toEqual(before);
    expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(signals);
    expect(staged()).toEqual([]);
    input.destroy();
  });

  it('bounds only input with --input-timeout-ms, never total graph execution', async () => {
    const cap = join(root, 'cap.json');
    const slow = `${drain};setTimeout(()=>require("fs").writeFileSync(process.argv[1],"done"),150)`;
    const bytes = manifest([await task('A', node(slow, cap))]);
    const { done, lines } = invoke(Readable.from([bytes]), ['--stdin', '--apply', '--input-timeout-ms', '60']);
    expect(await done).toBe(0);
    const result = JSON.parse(lines[0]!) as { status: string; nodes: { status: string }[] };
    expect(result.status).toBe('complete');
    expect(result.nodes[0]!.status).toBe('success');
    expect(readFileSync(cap, 'utf8')).toBe('done');
    expect(staged()).toEqual([]);
  }, 30000);

  it.each(['SIGINT', 'SIGTERM'] as const)('settles on %s during input and removes listeners', async signal => {
    const input = new PassThrough();
    const before = ['data', 'end', 'error', 'close'].map(event => input.listenerCount(event));
    const signals = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    const { done, lines } = invoke(input, ['--stdin', '--apply', '--input-timeout-ms', '5000']);
    input.write(manifest([await task('A', node(capture, join(root, 'cap.json')))]).subarray(0, 40));
    process.emit(signal);
    expect(await done).toBe(1);
    expect(JSON.parse(lines[0]!).error).toMatch(/interrupted/);
    expect(['data', 'end', 'error', 'close'].map(event => input.listenerCount(event))).toEqual(before);
    expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(signals);
    expect(input.destroyed).toBe(false);
    expect(staged()).toEqual([]);
    input.destroy();
  });

  it('stages the manifest privately and cleans it on interrupted execution', async () => {
    const started = join(root, 'started');
    const blocker = `require("fs").writeFileSync(process.argv[1],"x");${drain};setInterval(()=>{},1000)`;
    const bytes = manifest([await task('A', node(blocker, started)), await task('B', node(capture, join(root, 'b.json')))]);
    const { done, lines } = invoke(Readable.from([bytes]), ['--stdin', '--apply']);
    for (let i = 0; i < 1000 && !existsSync(started); i++) await sleep(5);
    expect(existsSync(started)).toBe(true);
    const found = staged();
    expect(found).toHaveLength(1);
    const dir = join(stage, found[0]!);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'manifest.json')).mode & 0o777).toBe(0o600);
    process.emit('SIGINT');
    expect(await done).toBe(1);
    const result = JSON.parse(lines[0]!) as { nodes: { status: string }[] };
    expect(result.nodes.map(n => n.status)).toEqual(['cancelled', 'cancelled']);
    expect(staged()).toEqual([]);
  }, 30000);

  it('rejects malformed, truncated and invalid graphs without launching', async () => {
    const cap = join(root, 'cap.json');
    const base = await task('A', node(capture, cap));
    const inputs: Buffer[] = [
      Buffer.from('{broken'),
      manifest([base, base]),
      manifest([{ ...base, dependsOn: ['NOPE'] }]),
      manifest([{ ...base, snapshot: 'relative/snap.json' }]),
      manifest([{ ...base, argv: [] }]),
      manifest([{ ...base, surprise: true }]),
      Buffer.from([0xff, 0xfe]),
      manifest([{ id: 'A', dependsOn: ['A'], snapshot: base.snapshot, prompt: base.prompt, argv: base.argv }]),
    ];
    for (const bytes of inputs) {
      const { done, lines } = invoke(Readable.from([bytes]), ['--stdin', '--apply']);
      expect(await done).toBe(2);
      expect(JSON.parse(lines[0]!).status).toBe('invalid');
      expect(existsSync(cap)).toBe(false);
      expect(staged()).toEqual([]);
    }
  });

  it('refuses launches while the runs PAUSE control is active', async () => {
    const cap = join(root, 'cap.json');
    const bytes = manifest([await task('A', node(capture, cap))]);
    await writeFile(join(runsDir, 'PAUSE'), '');
    const { done, lines } = invoke(Readable.from([bytes]), ['--stdin', '--apply']);
    expect(await done).toBe(1);
    const result = JSON.parse(lines[0]!) as { nodes: unknown[] };
    expect(result.nodes).toEqual([{ id: 'A', status: 'refused', exitCode: null }]);
    expect(existsSync(cap)).toBe(false);
    expect(staged()).toEqual([]);
  }, 30000);

  it('rejects invalid flags and TTY input and explains help', async () => {
    for (const args of [[], ['--stdin', '--stdin'], ['--stdin', '--apply', '--apply'], ['--stdin', '--unknown'],
      ['--stdin', '--concurrency', '0'], ['--stdin', '--concurrency', '9'], ['--stdin', '--input-timeout-ms', '0'],
      ['--stdin', '--input-timeout-ms', '60001'], ['--stdin', '--input-timeout-ms', '1.5'],
      ['--stdin', '--input-timeout-ms'], ['--help', '--stdin']]) {
      const { done } = invoke(Readable.from([]), args);
      expect(await done).toBe(2);
    }
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    expect(await invoke(tty).done).toBe(2);
    const help = invoke(Readable.from([]), ['--help']);
    expect(await help.done).toBe(0);
    expect(help.lines[0]).toContain('--stdin');
    expect(help.lines[0]).toContain('--apply');
    expect(help.lines[0]).toContain('--input-timeout-ms');
    expect(help.lines[0]).toMatch(/never bounds total graph execution/);
  });
});
