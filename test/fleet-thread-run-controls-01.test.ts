import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetThreadRun } from '../src/cli/fleet-thread-run.js';
import { appendBusInbox, type listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { runThreadWorker, THREAD_SECTION_END, THREAD_SECTION_START } from '../src/core/fleet/thread-worker-run.js';

let root: string, tmp: string, busRoot: string, snapshot: string, prompt: string, output: string;
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { output += s; }), stderr: sink(() => {}) });
const marker = () => join(root, 'child-marker');
const markerScript = () => `require('node:fs').writeFileSync(${JSON.stringify(marker())},'started');process.stdin.resume()`;
const args = (flags: string[], script = markerScript(), childArgs: string[] = []) => [
  '--id', 'root', '--snapshot', snapshot, '--prompt', prompt, '--byte-budget', '4096',
  ...flags, '--', process.execPath, '-e', script, '--', ...childArgs,
];
const run = (flags: string[], script?: string, childArgs?: string[]) =>
  cmdFleetThreadRun(args(flags, script, childArgs), { root: busRoot }, io());
const noSideEffects = async () => {
  expect(existsSync(marker())).toBe(false);
  expect(await readdir(tmp)).toEqual([]);
};
const recorder = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>` +
  `process.stdout.write(JSON.stringify({cwd:process.cwd(),stdin:s,args:process.argv.slice(1)})))`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'thread-controls-'));
  tmp = join(root, 'tmp'); busRoot = join(root, 'bus');
  await mkdir(tmp, { mode: 0o700 }); await mkdir(busRoot, { mode: 0o700 });
  await mkdir(join(root, 'runs'), { mode: 0o700 });
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs')); vi.stubEnv('TMPDIR', tmp);
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); output = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] },
    tasks: [], outputs: [], byteBudget: 800 }));
  await writeFile(prompt, 'Base prompt\n');
  for (const [id, body] of [
    ['root', { text: 'retained root' }],
    ['reply', { inReplyTo: 'root', text: 'retained reply' }],
  ] as const) {
    expect(appendBusInbox({ id, from: 'agent-a', to: 'agent-b', priority: 'P2', ttl: 60000, body },
      { root: busRoot }).status).toBe('posted');
  }
}, 30000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }, 30000);

it('passes the selected cwd and literal argv while citing the retained thread without changing the parent cwd', async () => {
  const selected = join(root, 'checkout $(literal); space');
  await mkdir(selected);
  const parentCwd = process.cwd();
  const literal = ['a b', '$(echo literal)', '--cwd', 'relative'];
  expect(await run(['--cwd', selected, '--timeout-ms', '3600000'], recorder, literal)).toBe(0);
  const result = JSON.parse(output) as { cwd: string; stdin: string; args: string[] };
  expect(result.cwd).toBe(realpathSync(selected));
  expect(process.cwd()).toBe(parentCwd);
  expect(result.args).toEqual(literal);
  expect(result.stdin.startsWith('Base prompt\n' + THREAD_SECTION_START)).toBe(true);
  const section = result.stdin.split(THREAD_SECTION_START)[1]!.split(THREAD_SECTION_END)[0]!;
  const rows = section.trim().split('\n').map(line => JSON.parse(line));
  expect(rows[0]).toMatchObject({ thread: 'root', messages: 2, scannedThrough: 2 });
  expect(rows.slice(1)).toMatchObject([
    { id: 'root', cursor: 1, body: { text: 'retained root' } },
    { id: 'reply', cursor: 2, body: { text: 'retained reply' } },
  ]);
  expect(await readdir(tmp)).toEqual([]);
}, 30000);

it('inherits cwd and completes normally when both controls are omitted', async () => {
  expect(await run([], recorder)).toBe(0);
  const result = JSON.parse(output) as { cwd: string; stdin: string };
  expect(result.cwd).toBe(process.cwd());
  expect(result.stdin).toContain('retained root');
  expect(await readdir(tmp)).toEqual([]);
}, 30000);

it('terminates a long-running child at its deadline and removes the temporary prompt', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const script = `${markerScript()};console.log('ready');setInterval(()=>{},1000)`;
  const started = Date.now();
  expect(await run(['--timeout-ms', '8000'], script)).toBe(124);
  expect(existsSync(marker())).toBe(true);
  expect(output).toContain('ready');
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 8000);
  expect(Date.now() - started).toBeLessThan(35000);
  expect(await readdir(tmp)).toEqual([]);
}, 45000);

it('accepts the minimum timeout and passes its exact value to the executor', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout');
  expect(await run(['--timeout-ms', '1'], 'process.stdin.resume();setInterval(()=>{},1000)')).toBe(124);
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 1);
  expect(await readdir(tmp)).toEqual([]);
}, 30000);

it.each([
  ['zero', ['--timeout-ms', '0']], ['over maximum', ['--timeout-ms', '3600001']],
  ['negative', ['--timeout-ms', '-1']], ['fraction', ['--timeout-ms', '1.5']],
  ['exponent', ['--timeout-ms', '1e3']], ['unsafe integer', ['--timeout-ms', '9007199254740992']],
  ['empty', ['--timeout-ms', '']], ['missing value', ['--timeout-ms']],
  ['duplicate timeout', ['--timeout-ms', '1', '--timeout-ms', '2']],
  ['relative cwd', ['--cwd', 'relative']], ['empty cwd', ['--cwd', '']],
  ['NUL cwd', ['--cwd', 'bad\0dir']], ['missing cwd value', ['--cwd']],
  ['duplicate cwd', ['--cwd', '/', '--cwd', '/']],
])('rejects %s before reading the bus or creating a prompt', async (_name, flags) => {
  const list = vi.fn();
  expect(await cmdFleetThreadRun(args(flags), { root: busRoot },
    { ...io(), list: list as unknown as typeof listBusInboxAfter })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  await noSideEffects();
});

it.each(['missing', 'file'])('rejects a cwd that is a %s before reading the bus or creating a prompt', async kind => {
  const list = vi.fn();
  const cwd = kind === 'missing' ? join(root, 'missing') : prompt;
  expect(await cmdFleetThreadRun(args(['--cwd', cwd]), { root: busRoot },
    { ...io(), list: list as unknown as typeof listBusInboxAfter })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  await noSideEffects();
});

it.each([
  { timeoutMs: 0 }, { timeoutMs: 3600001 }, { timeoutMs: 1.5 }, { timeoutMs: NaN },
  { cwd: 'relative' }, { cwd: '' }, { cwd: 42 as unknown as string },
])('rejects invalid API controls %o before reading the bus or creating a prompt', async controls => {
  const list = vi.fn();
  expect(await runThreadWorker({ id: 'root', snapshot, prompt, byteBudget: 4096,
    argv: [process.execPath, '-e', markerScript()], ...controls }, { root: busRoot }, io(),
  { list: list as unknown as typeof listBusInboxAfter })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  await noSideEffects();
});
