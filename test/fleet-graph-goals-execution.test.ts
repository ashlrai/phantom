import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetGraphGoals } from '../src/cli/fleet-graph-goals.js';
import { graphGoalsRun } from '../src/core/fleet/graph-goals-run.js';

vi.setConfig({ testTimeout: 60000 });
type Report = Awaited<ReturnType<typeof graphGoalsRun>>;
let dir: string, previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-goals-test-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const argv = (code: string, ...args: string[]) => [process.execPath, '-e', code, ...args];
const touch = (name: string) => argv('require("node:fs").appendFileSync(process.argv[1],"x")', join(dir, name));
const graph = (tasks: unknown[]) => {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
};
const scratch = () => readdirSync(tmpdir()).filter(name => name.startsWith('ashlr-graph-goals-')).sort();
async function cli(args: string[]): Promise<{ code: number; text: string; report?: Report }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await cmdFleetGraphGoals(args);
    const text = log.mock.calls.map(call => String(call[0])).join('\n');
    return { code, text, report: text.startsWith('{') ? JSON.parse(text) as Report : undefined };
  } finally { log.mockRestore(); }
}
const diamond = () => [
  { id: 'root', argv: touch('root') },
  { id: 'left', dependsOn: ['root'], argv: touch('left') },
  { id: 'right', dependsOn: ['root'], argv: touch('right') },
  { id: 'goal1', dependsOn: ['left', 'right'], argv: touch('goal1') },
  { id: 'goal2', dependsOn: ['left', 'right'], argv: touch('goal2') },
  { id: 'other', argv: touch('other') },
];

it('executes the union once and reports only selected terminal nodes', async () => {
  const before = scratch();
  const file = graph(diamond());
  const { code, report, text } = await cli(['--file', file, '--targets', 'goal2,goal1', '--apply', '--concurrency', '2', '--json']);
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: 'complete', targets: ['goal2', 'goal1'], selected: ['root', 'left', 'right', 'goal1', 'goal2'], skipped: ['other'] });
  expect(report!.nodes.map(node => node.status)).toEqual(Array(5).fill('success'));
  for (const name of report!.selected) expect(readFileSync(join(dir, name), 'utf8')).toBe('x');
  expect(existsSync(join(dir, 'other'))).toBe(false);
  expect(text).not.toContain('node:fs');
  expect(text).not.toContain(file);
  expect(scratch()).toEqual(before);
});

it('previews without scratch or processes and handles an overlapping target', async () => {
  const file = graph(diamond());
  const before = scratch();
  const { code, report } = await cli(['--file', file, '--targets', 'root,goal1', '--json']);
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: 'preview', selected: ['root', 'left', 'right', 'goal1'], skipped: ['goal2', 'other'] });
  expect(report!.nodes.every(node => node.status === 'planned')).toBe(true);
  expect(scratch()).toEqual(before);
  expect(readdirSync(dir)).toEqual(['graph.json']);
});

it('blocks both goals after a shared prerequisite fails', async () => {
  const before = scratch();
  const file = graph([{ id: 'root', argv: argv('process.exit(7)') },
    { id: 'goal1', dependsOn: ['root'], argv: touch('goal1') },
    { id: 'goal2', dependsOn: ['root'], argv: touch('goal2') }]);
  const { code, report } = await cli(['--file', file, '--targets', 'goal1,goal2', '--apply', '--json']);
  expect(code).toBe(1);
  expect(report!.nodes).toEqual([{ id: 'root', status: 'failed', exitCode: 7 },
    { id: 'goal1', status: 'blocked', exitCode: null }, { id: 'goal2', status: 'blocked', exitCode: null }]);
  expect(existsSync(join(dir, 'goal1'))).toBe(false);
  expect(existsSync(join(dir, 'goal2'))).toBe(false);
  expect(scratch()).toEqual(before);
});

it('rejects invalid unrelated tasks and unknown, duplicate, empty or excessive targets before effects', async () => {
  const before = scratch();
  const file = graph([...diamond(), { id: 'invalid', argv: [] }]);
  expect((await cli(['--file', file, '--targets', 'goal1,goal2', '--apply', '--json'])).report!.status).toBe('invalid');
  graph(diamond());
  for (const targets of ['goal1,missing', 'goal1,goal1', ',goal1', 'goal1,', '', Array(33).fill('goal1').join(',')]) {
    const out = await cli(['--file', file, '--targets', targets, '--apply', '--json']);
    expect(out.code).toBe(2);
    expect(out.report!.status).toBe('invalid-target');
  }
  expect(readdirSync(dir)).toEqual(['graph.json']);
  expect(scratch()).toEqual(before);
});

it('passes concurrency to the executor and honors a shared timeout', async () => {
  // Each process waits for its peer; sequential execution cannot complete.
  const peer = (own: string, other: string) => argv(
    'const f=require("node:fs");f.writeFileSync(process.argv[1],"x");const t=setInterval(()=>{if(f.existsSync(process.argv[2])){clearInterval(t)}},10)',
    join(dir, own), join(dir, other));
  let file = graph([{ id: 'a', argv: peer('a', 'b') }, { id: 'b', argv: peer('b', 'a') }]);
  let out = await cli(['--file', file, '--targets', 'a,b', '--apply', '--concurrency', '2', '--timeout-ms', '3000', '--json']);
  expect(out.code).toBe(0);
  file = graph([{ id: 'a', argv: argv('setInterval(()=>{},1000)') },
    { id: 'b', dependsOn: ['a'], argv: touch('never') }, { id: 'c', dependsOn: ['a'], argv: touch('never2') }]);
  out = await cli(['--file', file, '--targets', 'b,c', '--apply', '--timeout-ms', '200', '--json']);
  expect(out.code).toBe(1);
  expect(out.report!.nodes.map(row => row.status)).toEqual(['timeout', 'deadline-exhausted', 'deadline-exhausted']);
  expect(existsSync(join(dir, 'never'))).toBe(false);
});

it('retains control switches and refuses unsafe files', async () => {
  const file = graph([{ id: 'a', argv: touch('a') }]);
  writeFileSync(join(dir, 'ORCH_OFF'), '');
  const out = await cli(['--file', file, '--targets', 'a', '--apply', '--json']);
  expect(out.code).toBe(1);
  expect(out.report!.nodes[0]!.status).toBe('refused');
  chmodSync(file, 0o666);
  expect((await cli(['--file', file, '--targets', 'a', '--apply', '--json'])).code).toBe(2);
  expect(existsSync(join(dir, 'a'))).toBe(false);
});

it('parses flags, exports the command, and maps errors to exit 2', async () => {
  const file = graph([{ id: 'a', argv: touch('a') }]);
  expect(typeof cmdFleetGraphGoals).toBe('function');
  expect((await cli(['--help'])).text).toContain('fleet graph-goals');
  for (const args of [
    ['--help', '--json'], ['--file', file, '--targets', 'a'],
    ['--file', file, '--file', file, '--targets', 'a', '--json'],
    ['--file', file, '--targets', 'a', '--concurrency', '9', '--json'],
    ['--file', file, '--targets', 'a', '--timeout-ms', '0', '--json'],
    ['--file', 'relative', '--targets', 'a', '--json'],
  ]) expect((await cli(args)).code).toBe(2);
  expect(existsSync(join(dir, 'a'))).toBe(false);
});
