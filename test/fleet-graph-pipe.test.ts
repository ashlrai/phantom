import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { cmdFleetGraphPipe } from '../src/cli/fleet-graph-pipe.js';

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-pipe-test-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const graph = (tasks: unknown[]) => Buffer.from(JSON.stringify({ version: 1, tasks }));
const node = (id: string, code: string, dependsOn?: string[]) => ({
  id, argv: [process.execPath, '-e', code], ...(dependsOn ? { dependsOn } : {}),
});
const marker = () => join(root, 'marker');
const write = (value: string) => `require('node:fs').writeFileSync(${JSON.stringify(marker())},${JSON.stringify(value)})`;
function invoke(input: Readable, args = ['--stdin'], tempRoot = root) {
  const lines: string[] = [];
  const done = cmdFleetGraphPipe(args, { stdin: input, tempRoot, output: line => lines.push(line) });
  return { done, lines };
}
const staged = () => readdirSync(root).filter(name => name.startsWith('phantom-graph-pipe-'));

it('executes a dependency graph in order and cleans its private staging directory', async () => {
  const second = `const fs=require('node:fs');if(fs.readFileSync(${JSON.stringify(marker())},'utf8')!=='first')process.exit(7);${write('second')}`;
  const input = graph([node('first', write('first')), node('second', second, ['first'])]);
  const { done, lines } = invoke(Readable.from([input]), ['--stdin', '--apply', '--concurrency', '2', '--json']);
  expect(await done).toBe(0);
  expect(JSON.parse(lines[0]!).nodes.map((row: { status: string }) => row.status)).toEqual(['success', 'success']);
  expect(readFileSync(marker(), 'utf8')).toBe('second');
  expect(staged()).toEqual([]);
});

it('previews fragmented UTF-8 input without executing before or after EOF', async () => {
  const input = new PassThrough();
  const { done, lines } = invoke(input);
  const bytes = graph([node('first', write('é'))]);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  input.write(bytes.subarray(0, split));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(existsSync(marker())).toBe(false);
  input.end(bytes.subarray(split));
  expect(await done).toBe(0);
  expect(JSON.parse(lines[0]!).status).toBe('preview');
  expect(existsSync(marker())).toBe(false);
  expect(staged()).toEqual([]);
});

it('does not launch before EOF and times out without destroying the stream', async () => {
  const input = new PassThrough();
  const before = ['data', 'end', 'error', 'close'].map(event => input.listenerCount(event));
  const signals = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
  const { done, lines } = invoke(input, ['--stdin', '--apply', '--timeout-ms', '80']);
  input.write(graph([node('first', write('bad'))]));
  expect(await done).toBe(1);
  expect(JSON.parse(lines[0]!).error).toMatch(/deadline/);
  expect(input.destroyed).toBe(false);
  expect(['data', 'end', 'error', 'close'].map(event => input.listenerCount(event))).toEqual(before);
  expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(signals);
  expect(existsSync(marker())).toBe(false);
  expect(staged()).toEqual([]);
  input.destroy();
});

it.each(['SIGINT', 'SIGTERM'] as const)('settles on %s during input and removes listeners', async signal => {
  const input = new PassThrough();
  const before = ['data', 'end', 'error', 'close'].map(event => input.listenerCount(event));
  const signals = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
  const { done, lines } = invoke(input, ['--stdin', '--apply', '--timeout-ms', '5000']);
  input.write(graph([node('first', write('bad'))]));
  process.emit(signal);
  expect(await done).toBe(1);
  expect(JSON.parse(lines[0]!).error).toMatch(/interrupted/);
  expect(['data', 'end', 'error', 'close'].map(event => input.listenerCount(event))).toEqual(before);
  expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(signals);
  expect(input.destroyed).toBe(false);
  expect(existsSync(marker())).toBe(false);
  input.destroy();
});

it('rejects invalid graphs, malformed UTF-8 and oversized input without launching', async () => {
  const badGraph = graph([node('first', write('bad')), { id: 'second', argv: [] }]);
  for (const bytes of [badGraph, Buffer.from('{broken'), Buffer.from([0xff]), Buffer.alloc(262145, 32)]) {
    const { done, lines } = invoke(Readable.from([bytes]), ['--stdin', '--apply']);
    expect(await done).toBe(2);
    expect(JSON.parse(lines[0]!).status).toBe('invalid');
    expect(lines[0]).not.toContain('writeFileSync');
    expect(existsSync(marker())).toBe(false);
    expect(staged()).toEqual([]);
  }
});

it('cleans staging on child failure and enforces switches', async () => {
  let result = invoke(Readable.from([graph([node('fail', 'process.exit(7)')])]), ['--stdin', '--apply']);
  expect(await result.done).toBe(1);
  expect(JSON.parse(result.lines[0]!).nodes[0].status).toBe('failed');
  expect(staged()).toEqual([]);
  writeFileSync(join(root, 'PAUSE'), '');
  result = invoke(Readable.from([graph([node('first', write('bad'))])]), ['--stdin', '--apply']);
  expect(await result.done).toBe(1);
  expect(JSON.parse(result.lines[0]!).nodes[0].status).toBe('refused');
  expect(existsSync(marker())).toBe(false);
  expect(staged()).toEqual([]);
});

it('rejects invalid flags and TTY input and explains help', async () => {
  for (const args of [[], ['--stdin', '--stdin'], ['--stdin', '--apply', '--apply'], ['--stdin', '--unknown'],
    ['--stdin', '--concurrency', '0'], ['--stdin', '--concurrency', '9'], ['--stdin', '--timeout-ms', '0'],
    ['--stdin', '--timeout-ms', '3600001'], ['--stdin', '--timeout-ms', '1.5'], ['--help', '--stdin']]) {
    const { done } = invoke(Readable.from([]), args);
    expect(await done).toBe(2);
  }
  const tty = Object.assign(Readable.from([]), { isTTY: true });
  expect(await invoke(tty).done).toBe(2);
  const help = invoke(Readable.from([]), ['--help']);
  expect(await help.done).toBe(0);
  expect(help.lines[0]).toContain('--stdin');
  expect(help.lines[0]).toContain('--apply');
});
