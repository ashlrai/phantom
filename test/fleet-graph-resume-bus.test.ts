import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { GRAPH_OBSERVE_SCHEMA } from '../src/core/fleet/graph-observed-run.js';
import { graphResumeRun } from '../src/core/fleet/graph-resume-run.js';
import { cmdFleetGraphResume } from '../src/cli/fleet-graph-resume.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let dir: string, root: string, file: string, checkpoint: string;
let previousRuns: string | undefined, output: ReturnType<typeof vi.spyOn>;

const argv = (code: string): string[] => [process.execPath, '-e', code];
const marker = (name: string) => join(dir, name);
const count = (name: string): number => (existsSync(marker(name)) ? Number(readFileSync(marker(name), 'utf8')) : 0);
const bump = (name: string) => argv(
  `const fs=require('node:fs');const p=${JSON.stringify(marker(name))};` +
  'let c=0;try{c=+fs.readFileSync(p,\'utf8\')}catch{}fs.writeFileSync(p,String(c+1))',
);
// B fails on its first launch (leaving a gate marker), then counts each retry.
const flakyB = () => argv(
  `const fs=require('node:fs');const g=${JSON.stringify(marker('b-gate'))};` +
  `if(!fs.existsSync(g)){fs.writeFileSync(g,'');process.exit(7)}` +
  `const p=${JSON.stringify(marker('b-count'))};let c=0;try{c=+fs.readFileSync(p,'utf8')}catch{}fs.writeFileSync(p,String(c+1))`,
);
const GROUP = ['--run-id', 'resume-1', '--from', 'agent:runner', '--to', 'agent:observer'];
const cli = (extra: string[] = [], busRoot = root) =>
  cmdFleetGraphResume(['--file', file, '--checkpoint', checkpoint, '--json', ...extra], { root: busRoot });
const last = () => JSON.parse(String(output.mock.calls.at(-1)![0])) as Record<string, any>;
const inbox = () => {
  const page = listBusInboxAfter(0, 10, { root });
  if (page.status !== 'ok') throw new Error(`inbox read failed: ${page.status}`);
  return page.messages;
};

/** Seed a real partial checkpoint through the existing runner: A succeeds, B fails once. */
async function seedPartial(): Promise<void> {
  const seed = await graphResumeRun(file, checkpoint, true, 20_000);
  expect(seed.status).toBe('failed');
  expect(seed.nodes).toEqual([
    { id: 'A', status: 'success', exitCode: 0 },
    { id: 'B', status: 'failed', exitCode: 7 },
  ]);
  expect(count('a-count')).toBe(1);
  expect(count('b-count')).toBe(0);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-resume-bus-'));
  root = mkdtempSync(join(tmpdir(), 'graph-resume-bus-root-'));
  mkdirSync(join(dir, 'runs'));
  previousRuns = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = join(dir, 'runs');
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  file = join(dir, 'graph.json');
  checkpoint = join(dir, 'checkpoint.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    tasks: [
      { id: 'A', argv: bump('a-count') },
      { id: 'B', dependsOn: ['A'], argv: flakyB() },
    ],
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previousRuns;
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('resumes only the failed node and posts one terminal summary to the real inbox', async () => {
  await seedPartial();
  expect(await cli([...GROUP, '--apply'])).toBe(0);
  const result = last();
  expect(result.schema).toBe('fleet.graph-resume.run.v1');
  expect(result.mode).toBe('apply');
  expect(result.execution.status).toBe('complete');
  expect(result.execution.retained).toEqual(['A']);
  expect(result.execution.retried).toEqual(['B']);
  expect(result.execution.nodes).toEqual([
    { id: 'A', status: 'success', exitCode: 0 },
    { id: 'B', status: 'success', exitCode: 0 },
  ]);
  expect(result.delivery).toMatchObject({ status: 'posted', id: 'graph-observe:resume-1', cursor: 1 });
  // A's checkpointed success was retained: only B launched a child.
  expect(count('a-count')).toBe(1);
  expect(count('b-count')).toBe(1);
  const messages = inbox();
  expect(messages).toHaveLength(1);
  const { envelope } = messages[0]!;
  expect(envelope).toMatchObject({
    id: 'graph-observe:resume-1', from: 'agent:runner', to: 'agent:observer', priority: 'P2',
    body: {
      schema: GRAPH_OBSERVE_SCHEMA, runId: 'resume-1', status: 'complete',
      nodes: [
        { id: 'A', status: 'success', exitCode: 0 },
        { id: 'B', status: 'success', exitCode: 0 },
      ],
    },
  });
  // The wire payload carries outcomes only: no argv, paths, environment or output text.
  const wire = JSON.stringify(envelope);
  for (const leak of [file, checkpoint, dir, process.execPath, '-e', 'argv', 'b-gate']) {
    expect(wire).not.toContain(leak);
  }
});

it('dedupes delivery and spawns no child when the checkpoint is already complete', async () => {
  await seedPartial();
  expect(await cli([...GROUP, '--apply'])).toBe(0);
  expect(await cli([...GROUP, '--apply'])).toBe(0);
  const result = last();
  expect(result.execution.status).toBe('complete');
  expect(result.execution.retried).toEqual([]);
  expect(result.delivery).toMatchObject({ status: 'duplicate', id: 'graph-observe:resume-1', cursor: 1 });
  expect(count('a-count')).toBe(1);
  expect(count('b-count')).toBe(1);
  expect(inbox()).toHaveLength(1);
});

it('preview launches no children and writes nothing to the inbox', async () => {
  await seedPartial();
  expect(await cli(GROUP)).toBe(0);
  const result = last();
  expect(result.mode).toBe('preview');
  expect(result.execution.status).toBe('preview');
  expect(result.execution.retained).toEqual(['A']);
  expect(result.execution.retried).toEqual(['B']);
  expect(result.delivery).toEqual({ status: 'not-attempted' });
  expect(count('a-count')).toBe(1);
  expect(count('b-count')).toBe(0);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('refuses incomplete or invalid routing groups before any child or post', async () => {
  const bad = [
    ['--run-id', 'resume-1'],
    ['--from', 'agent:runner', '--to', 'agent:observer'],
    ['--run-id', 'has space', '--from', 'agent:runner', '--to', 'agent:observer'],
    ['--run-id', 'x'.repeat(65), '--from', 'agent:runner', '--to', 'agent:observer'],
    ['--run-id', 'resume-1', '--from', 'white space', '--to', 'agent:observer'],
    ['--run-id', 'resume-1', '--from', 'agent:runner', '--to', 'x'.repeat(129)],
    [...GROUP, '--timeout-ms', '0'],
  ];
  for (const flags of bad) {
    expect(await cli([...flags, '--apply'])).toBe(2);
    expect(last()).toEqual({ status: 'invalid' });
  }
  // Group flags still require --json, and unknown flags still refuse silently.
  expect(await cmdFleetGraphResume(['--file', file, '--checkpoint', checkpoint, ...GROUP])).toBe(2);
  expect(await cmdFleetGraphResume(['--file', file, '--checkpoint', checkpoint, '--json', ...GROUP, '--bogus'])).toBe(2);
  expect(count('a-count')).toBe(0);
  expect(count('b-count')).toBe(0);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('reports delivery failure without executing the graph twice', async () => {
  await seedPartial();
  const occupied = join(root, 'not-a-directory');
  writeFileSync(occupied, 'occupied', { mode: 0o600 });
  expect(await cli([...GROUP, '--apply'], occupied)).toBe(1);
  const result = last();
  expect(result.execution.status).toBe('complete');
  expect(result.execution.retained).toEqual(['A']);
  expect(result.delivery.status).toBe('unavailable');
  expect(count('a-count')).toBe(1);
  expect(count('b-count')).toBe(1);
});

it('never publishes an invalid outcome as a success', async () => {
  file = join(dir, 'missing.json');
  expect(await cli([...GROUP, '--apply'])).toBe(2);
  const result = last();
  expect(result.execution.status).toBe('invalid');
  expect(result.delivery).toEqual({ status: 'not-attempted' });
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('publishes a refused retry as a failed terminal outcome, not a success', async () => {
  await seedPartial();
  writeFileSync(join(dir, 'runs', 'PAUSE'), '');
  expect(await cli([...GROUP, '--apply'])).toBe(1);
  const result = last();
  expect(result.execution.status).toBe('failed');
  expect(result.execution.nodes).toEqual([
    { id: 'A', status: 'success', exitCode: 0 },
    { id: 'B', status: 'refused', exitCode: null },
  ]);
  expect(result.delivery.status).toBe('posted');
  expect(count('b-count')).toBe(0);
  const messages = inbox();
  expect((messages[0]!.envelope.body as { status: string }).status).toBe('failed');
});

it('prints command-local help and resolves the convention dispatch', async () => {
  expect(await cmdFleetGraphResume(['--help'])).toBe(0);
  expect(String(output.mock.calls.at(-1)![0])).toContain('--run-id');
  expect(await cmdFleetGraphResume(['-h'])).toBe(0);
  expect(resolveFleetSubcommand('graph-resume'))
    .toEqual({ module: './fleet-graph-resume.js', exportName: 'cmdFleetGraphResume' });
});
