import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphArgvRun } from '../src/core/fleet/graph-argv-run.js';

let dir: string;
let previous: string | undefined;
const argv = (code: string, ...args: string[]): string[] => [process.execPath, '-e', code, ...args];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-cwd-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

async function run(tasks: unknown[], apply = true, concurrency = 1) {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return graphArgvRun(file, apply, 5000, concurrency);
}

it('runs independent tasks concurrently in their own directories with literal argv', async () => {
  const first = join(dir, 'repo one');
  const second = join(dir, 'repo two');
  mkdirSync(first); mkdirSync(second);
  writeFileSync(join(first, 'input'), 'first');
  writeFileSync(join(second, 'input'), 'second');
  const code = `const fs = require('node:fs');
    fs.writeFileSync('started', fs.readFileSync('input', 'utf8'));
    const timer = setInterval(() => {
      if (fs.existsSync(process.argv[1])) {
        clearInterval(timer);
        fs.writeFileSync('output', fs.readFileSync('input', 'utf8') + ':' + process.argv[2]);
      }
    }, 10);`;
  const original = process.cwd();
  const result = await run([
    { id: 'A', cwd: first, argv: argv(code, join(second, 'started'), '$(literal); *') },
    { id: 'B', cwd: second, argv: argv(code, join(first, 'started'), '$(literal); *') },
  ], true, 2);
  expect(result.status).toBe('complete');
  expect(result.nodes.map(node => node.status)).toEqual(['success', 'success']);
  expect(readFileSync(join(first, 'output'), 'utf8')).toBe('first:$(literal); *');
  expect(readFileSync(join(second, 'output'), 'utf8')).toBe('second:$(literal); *');
  expect(process.cwd()).toBe(original);
});

it('inherits the process directory when cwd is omitted', async () => {
  const marker = join(dir, 'inherited');
  const result = await run([{ id: 'A', argv: argv("require('node:fs').writeFileSync(process.argv[1], process.cwd())", marker) }]);
  expect(result.status).toBe('complete');
  expect(readFileSync(marker, 'utf8')).toBe(process.cwd());
});

it('validates preview without starting a child', async () => {
  const marker = join(dir, 'marker');
  const result = await run([{ id: 'A', cwd: dir, argv: argv("require('node:fs').writeFileSync(process.argv[1], 'x')", marker) }], false);
  expect(result).toEqual({ status: 'preview', nodes: [{ id: 'A', status: 'planned', exitCode: null }] });
  expect(existsSync(marker)).toBe(false);
});

it('rejects every invalid later cwd before preview or any child starts', async () => {
  const marker = join(dir, 'marker');
  const ordinaryFile = join(dir, 'file');
  writeFileSync(ordinaryFile, 'x');
  for (const cwd of ['', 'relative', join(dir, 'missing'), ordinaryFile, `${dir}\0bad`, null, 42]) {
    const tasks = [
      { id: 'A', cwd: dir, argv: argv("require('node:fs').writeFileSync(process.argv[1], 'x')", marker) },
      { id: 'B', cwd, argv: argv('') },
    ];
    expect(await run(tasks, false)).toEqual({ status: 'invalid', nodes: [] });
    expect(await run(tasks)).toEqual({ status: 'invalid', nodes: [] });
    expect(existsSync(marker)).toBe(false);
  }
});

it('treats shell metacharacters in a directory as literal characters', async () => {
  const literal = join(dir, 'repo $(literal); [x]');
  mkdirSync(literal);
  const result = await run([{ id: 'A', cwd: literal, argv: argv("require('node:fs').writeFileSync('output', process.cwd())") }]);
  expect(result.status).toBe('complete');
  expect(readFileSync(join(literal, 'output'), 'utf8')).toBe(realpathSync(literal));
});

it('fails a node whose validated directory disappears and blocks its descendant', async () => {
  const removed = join(dir, 'removed');
  const marker = join(dir, 'marker');
  mkdirSync(removed);
  const result = await run([
    { id: 'A', argv: argv("require('node:fs').rmdirSync(process.argv[1])", removed) },
    { id: 'B', dependsOn: ['A'], cwd: removed, argv: argv('') },
    { id: 'C', dependsOn: ['B'], argv: argv("require('node:fs').writeFileSync(process.argv[1], 'x')", marker) },
  ]);
  expect(result.status).toBe('failed');
  expect(result.nodes.map(node => node.status)).toEqual(['success', 'failed', 'blocked']);
  expect(result.nodes[1]?.exitCode).not.toBe(0);
  expect(existsSync(marker)).toBe(false);
});
