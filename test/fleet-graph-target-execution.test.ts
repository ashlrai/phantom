import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000 });
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetGraphTarget } from '../src/cli/fleet-graph-target.js';

interface Report { status: string; target: string; selected: string[]; skipped: string[]; nodes: { id: string; status: string; exitCode: number | null }[] }

let dir: string, previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-target-'));
  previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const argv = (code: string, ...args: string[]): string[] => [process.execPath, '-e', code, ...args];
const touch = (name: string) => argv(`require('node:fs').writeFileSync(${JSON.stringify(join(dir, name))},'ok')`);
const graph = (tasks: unknown[]): string => {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
};
async function cli(args: string[]): Promise<{ code: number; text: string[]; report?: Report }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetGraphTarget(args);
  const text = log.mock.calls.map(call => String(call[0]));
  const line = text.find(value => value.startsWith('{'));
  return { code, text, report: line === undefined ? undefined : JSON.parse(line) as Report };
}
const scratchDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith('ashlr-graph-target-'));

it('runs only the target and its transitive prerequisites', async () => {
  const file = graph([
    { id: 'A', argv: touch('A') }, { id: 'B', dependsOn: ['A'], argv: touch('B') },
    { id: 'T', dependsOn: ['B'], argv: touch('T') }, { id: 'X', argv: touch('X') },
  ]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: 'complete', target: 'T', selected: ['A', 'B', 'T'], skipped: ['X'] });
  expect(report!.nodes.every(node => node.status === 'success')).toBe(true);
  for (const name of ['A', 'B', 'T']) expect(existsSync(join(dir, name))).toBe(true);
  expect(existsSync(join(dir, 'X'))).toBe(false);
});

it('runs a shared prerequisite exactly once', async () => {
  const count = join(dir, 'count');
  const bump = argv(`require('node:fs').appendFileSync(${JSON.stringify(count)},'x')`);
  const file = graph([
    { id: 'A', argv: bump }, { id: 'B', dependsOn: ['A'], argv: touch('B') },
    { id: 'C', dependsOn: ['A'], argv: touch('C') }, { id: 'T', dependsOn: ['B', 'C'], argv: touch('T') },
  ]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--concurrency', '2', '--json']);
  expect(code).toBe(0);
  expect(report!.status).toBe('complete');
  expect(readFileSync(count, 'utf8')).toBe('x');
});

it('preserves an explicit per-node cwd', async () => {
  const work = join(dir, 'work');
  mkdirSync(work);
  const file = graph([{ id: 'T', cwd: work, argv: argv(`require('node:fs').writeFileSync('output',process.cwd())`) }]);
  const { code } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(0);
  expect(existsSync(join(work, 'output'))).toBe(true);
});

it('preview writes no scratch and launches nothing', async () => {
  const file = graph([{ id: 'A', argv: touch('A') }, { id: 'T', dependsOn: ['A'], argv: touch('T') }, { id: 'X', argv: touch('X') }]);
  const before = scratchDirs();
  const { code, report } = await cli(['--file', file, '--target', 'T', '--json']);
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: 'preview', selected: ['A', 'T'], skipped: ['X'] });
  expect(report!.nodes).toEqual([{ id: 'A', status: 'planned', exitCode: null }, { id: 'T', status: 'planned', exitCode: null }]);
  expect(scratchDirs()).toEqual(before);
  for (const name of ['A', 'T', 'X']) expect(existsSync(join(dir, name))).toBe(false);
});

it('rejects an unknown target without launching', async () => {
  const file = graph([{ id: 'T', argv: touch('T') }]);
  const { code, report } = await cli(['--file', file, '--target', 'NOPE', '--apply', '--json']);
  expect(code).toBe(2);
  expect(report!.status).toBe('invalid-target');
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('rejects a cyclic graph without launching', async () => {
  const file = graph([
    { id: 'A', dependsOn: ['B'], argv: touch('A') }, { id: 'B', dependsOn: ['A'], argv: touch('B') }, { id: 'T', argv: touch('T') },
  ]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(2);
  expect(report!.status).toBe('invalid');
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('rejects the whole manifest when an unrelated task is invalid', async () => {
  const file = graph([{ id: 'T', argv: touch('T') }, { id: 'X', argv: [] }]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(2);
  expect(report!.status).toBe('invalid');
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('rejects malformed flags without launching', async () => {
  const file = graph([{ id: 'T', argv: touch('T') }]);
  for (const args of [
    ['--file', file, '--target', 'T', '--apply'],
    ['--file', file, '--target', 'T', '--json', '--bogus'],
    ['--file', file, '--file', file, '--target', 'T', '--json'],
    ['--file', file, '--target', 'T', '--json', '--concurrency', '9'],
    ['--file', file, '--target', 'T', '--json', '--timeout-ms', '0'],
    ['--file', 'relative.json', '--target', 'T', '--json', '--apply'],
  ]) {
    expect((await cli(args)).code).toBe(2);
  }
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('a failed prerequisite blocks the target and exits nonzero', async () => {
  const file = graph([
    { id: 'A', argv: argv('process.exit(7)') }, { id: 'T', dependsOn: ['A'], argv: touch('T') }, { id: 'X', argv: touch('X') },
  ]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(1);
  expect(report!.status).toBe('failed');
  expect(report!.nodes).toEqual([{ id: 'A', status: 'failed', exitCode: 7 }, { id: 'T', status: 'blocked', exitCode: null }]);
  expect(existsSync(join(dir, 'T'))).toBe(false);
  expect(existsSync(join(dir, 'X'))).toBe(false);
});

it('delegates control-switch refusal to the real executor', async () => {
  writeFileSync(join(dir, 'ORCH_OFF'), '');
  const file = graph([{ id: 'T', argv: touch('T') }]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(1);
  expect(report!.status).toBe('failed');
  expect(report!.nodes).toEqual([{ id: 'T', status: 'refused', exitCode: null }]);
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('delegates the shared deadline to the executor', async () => {
  const file = graph([{ id: 'A', argv: argv('setInterval(()=>{},1000)') }, { id: 'T', dependsOn: ['A'], argv: touch('T') }]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--timeout-ms', '200', '--json']);
  expect(code).toBe(1);
  expect(report!.nodes).toEqual([{ id: 'A', status: 'timeout', exitCode: null }, { id: 'T', status: 'deadline-exhausted', exitCode: null }]);
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('passes argv literally and keeps it out of the report', async () => {
  const literal = '$(touch PWNED); * `id`';
  const marker = join(dir, 'literal');
  const file = graph([
    { id: 'T', argv: argv("require('node:fs').writeFileSync(process.argv[1],process.argv[2])", marker, literal) }, { id: 'X', argv: touch('X') },
  ]);
  const { code, report, text } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(0);
  expect(text.length).toBe(1);
  expect(readFileSync(marker, 'utf8')).toBe(literal);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain('node:fs');
  expect(serialized).not.toContain(literal);
  expect(Object.keys(report!.nodes[0]!).sort()).toEqual(['exitCode', 'id', 'status']);
  expect(existsSync(join(dir, 'PWNED'))).toBe(false);
});

it('keeps raw child output out of the JSON report', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const file = graph([{ id: 'T', argv: argv("console.log('child-stdout-line');console.error('child-stderr-line')") }]);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(0);
  expect(JSON.stringify(report)).not.toContain('child-');
});

it.each([0o666, 0o777])('refuses a world-writable manifest (mode %o) without launching', async mode => {
  const file = graph([{ id: 'T', argv: touch('T') }]);
  chmodSync(file, mode);
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(2);
  expect(report!.status).toBe('invalid');
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('refuses a manifest carrying extra hard links', async () => {
  const file = graph([{ id: 'T', argv: touch('T') }]);
  linkSync(file, join(dir, 'linked.json'));
  const { code, report } = await cli(['--file', file, '--target', 'T', '--apply', '--json']);
  expect(code).toBe(2);
  expect(report!.status).toBe('invalid');
  expect(existsSync(join(dir, 'T'))).toBe(false);
});

it('prints usage for --help and only --help', async () => {
  const { code, text } = await cli(['--help']);
  expect(code).toBe(0);
  expect(text.join('\n')).toContain('fleet graph-target');
  expect(await cmdFleetGraphTarget(['--help', '--file', 'x'])).toBe(2);
});
