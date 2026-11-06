import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import {
  GRAPH_OBSERVE_SCHEMA, GRAPH_OBSERVE_TTL_MS, graphObservedRun, publishGraphTerminalSummary,
} from '../src/core/fleet/graph-observed-run.js';
import { cmdFleetGraphObserve } from '../src/cli/fleet-graph-observe.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let dir: string, root: string, previousRuns: string | undefined, output: ReturnType<typeof vi.spyOn>;
const argv = (code: string): string[] => [process.execPath, '-e', code];
const marker = (name: string) => join(dir, name);
const touch = (name: string) => argv(`require('node:fs').writeFileSync(${JSON.stringify(marker(name))},'ok')`);
const counter = () => marker('counter');
const bump = () => argv(`const fs=require('node:fs');let c=0;try{c=+fs.readFileSync(${JSON.stringify(counter())},'utf8')}catch{}fs.writeFileSync(${JSON.stringify(counter())},String(c+1))`);

function manifest(tasks: unknown[]): string {
  const file = join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks }));
  return file;
}
function base(file: string, runId = 'run-1'): string[] {
  return ['--file', file, '--run-id', runId, '--from', 'agent:runner', '--to', 'agent:observer', '--timeout-ms', '20000'];
}
function last(): Record<string, unknown> {
  return JSON.parse(String(output.mock.calls.at(-1)![0])) as Record<string, unknown>;
}
function readCounter(): number {
  return existsSync(counter()) ? Number(readFileSync(counter(), 'utf8')) : 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-observe-'));
  root = mkdtempSync(join(tmpdir(), 'graph-observe-bus-'));
  mkdirSync(join(dir, 'runs'));
  previousRuns = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = join(dir, 'runs');
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previousRuns;
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('runs a dependency graph once and delivers one terminal summary to the real inbox', async () => {
  const file = manifest([
    { id: 'A', argv: touch('a') },
    { id: 'B', dependsOn: ['A'], argv: argv(`require('node:fs').accessSync(${JSON.stringify(marker('a'))})`) },
  ]);
  expect(await cmdFleetGraphObserve([...base(file), '--apply', '--json'], { root })).toBe(0);
  const result = last() as { mode: string; execution: { status: string; nodes: { id: string; status: string; exitCode: number }[] }; delivery: { status: string; id: string; cursor: number } };
  expect(result.mode).toBe('apply');
  expect(result.execution.status).toBe('complete');
  expect(result.execution.nodes).toEqual([
    { id: 'A', status: 'success', exitCode: 0 },
    { id: 'B', status: 'success', exitCode: 0 },
  ]);
  expect(result.delivery.status).toBe('posted');
  const page = listBusInboxAfter(0, 10, { root });
  if (page.status !== 'ok') throw new Error(`inbox read failed: ${page.status}`);
  expect(page.messages).toHaveLength(1);
  const { envelope } = page.messages[0]!;
  expect(envelope).toMatchObject({
    id: 'graph-observe:run-1', from: 'agent:runner', to: 'agent:observer',
    priority: 'P2',
    body: {
      schema: GRAPH_OBSERVE_SCHEMA, runId: 'run-1', status: 'complete',
      nodes: [
        { id: 'A', status: 'success', exitCode: 0 },
        { id: 'B', status: 'success', exitCode: 0 },
      ],
    },
  });
  // TTL is decremented by elapsed time on read; the posted value was the bound.
  expect(envelope.ttl).toBeGreaterThan(0);
  expect(envelope.ttl).toBeLessThanOrEqual(GRAPH_OBSERVE_TTL_MS);
  // The wire payload carries outcomes only: no argv, paths, environment or output text.
  const wire = JSON.stringify(envelope);
  for (const leak of [file, dir, process.execPath, '-e', 'argv', 'accessSync']) expect(wire).not.toContain(leak);
});

it('leaves downstream blocked in the summary when a parent fails, and still exits nonzero', async () => {
  const file = manifest([
    { id: 'A', argv: argv('process.exit(7)') },
    { id: 'B', dependsOn: ['A'], argv: touch('b') },
    { id: 'C', argv: argv('') },
  ]);
  expect(await cmdFleetGraphObserve([...base(file, 'run-failed'), '--apply', '--json'], { root })).toBe(1);
  const result = last() as { execution: { status: string; nodes: { id: string; status: string; exitCode: number | null }[] }; delivery: { status: string } };
  expect(result.execution.status).toBe('failed');
  // Frontier order: independent C is scheduled alongside A; B waits on A.
  expect(result.execution.nodes).toEqual([
    { id: 'A', status: 'failed', exitCode: 7 },
    { id: 'C', status: 'success', exitCode: 0 },
    { id: 'B', status: 'blocked', exitCode: null },
  ]);
  expect(result.delivery.status).toBe('posted');
  expect(existsSync(marker('b'))).toBe(false);
  const page = listBusInboxAfter(0, 10, { root });
  if (page.status !== 'ok') throw new Error('inbox read failed');
  expect((page.messages[0]!.envelope.body as { nodes: { id: string; status: string }[] }).nodes)
    .toContainEqual({ id: 'B', status: 'blocked', exitCode: null });
});

it('preview spawns no children and writes nothing to the inbox', async () => {
  const file = manifest([{ id: 'A', argv: touch('a') }, { id: 'B', dependsOn: ['A'], argv: touch('b') }]);
  expect(await cmdFleetGraphObserve([...base(file, 'run-preview'), '--json'], { root })).toBe(0);
  const result = last() as { mode: string; execution: { status: string; nodes: { id: string; status: string }[] }; delivery: { status: string; envelope: { id: string; nodeRows: number; bytes: number } } };
  expect(result.mode).toBe('preview');
  expect(result.execution.status).toBe('preview');
  expect(result.execution.nodes.every(node => node.status === 'planned')).toBe(true);
  expect(result.delivery.status).toBe('preview');
  expect(result.delivery.envelope).toMatchObject({ id: 'graph-observe:run-preview', from: 'agent:runner', to: 'agent:observer', priority: 'P2', ttl: GRAPH_OBSERVE_TTL_MS, nodeRows: 2 });
  expect(result.delivery.envelope.bytes).toBeGreaterThan(0);
  expect(existsSync(marker('a'))).toBe(false);
  expect(existsSync(marker('b'))).toBe(false);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('rejects invalid flags and metadata before any child or inbox write', async () => {
  const file = manifest([{ id: 'A', argv: touch('a') }]);
  const bad = [
    [], ['--help', '--apply'],
    base(file).slice(0, -1),
    base(file).slice(4),
    [...base(file), '--to', 'agent:other'],
    base(file).map(v => v === file ? 'relative/path.json' : v),
    base(file, 'has space'),
    base(file, 'x'.repeat(65)),
    base(file).map(v => v === '20000' ? '0' : v),
    base(file).map(v => v === '20000' ? '1e3' : v),
    base(file).map(v => v === '20000' ? '3600001' : v),
    [...base(file), '--bogus'],
    [...base(file), '--file', file],
    [...base(file), '--apply', '--apply'],
    [...base(file), '--json', '--json'],
    base(file).map(v => v === 'agent:runner' ? 'white space' : v),
  ];
  for (const args of bad) {
    expect(await cmdFleetGraphObserve(args, { root })).toBe(2);
    expect(last()).toEqual({ status: 'invalid' });
  }
  expect(existsSync(marker('a'))).toBe(false);
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('treats an unreadable manifest as invalid input without a delivery attempt', async () => {
  const file = join(dir, 'missing.json');
  expect(await cmdFleetGraphObserve([...base(file, 'run-invalid'), '--apply', '--json'], { root })).toBe(2);
  const result = last() as { execution: { status: string }; delivery: { status: string } };
  expect(result.execution.status).toBe('invalid');
  expect(result.delivery.status).toBe('not-attempted');
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('preserves the execution result and exits nonzero when the bus is unavailable', async () => {
  const file = manifest([{ id: 'A', argv: bump() }]);
  const busFile = join(root, 'not-a-directory');
  writeFileSync(busFile, 'occupied', { mode: 0o600 });
  expect(await cmdFleetGraphObserve([...base(file, 'run-bus'), '--apply', '--json'], { root: busFile })).toBe(1);
  const result = last() as { execution: { status: string }; delivery: { status: string } };
  expect(result.execution.status).toBe('complete');
  expect(result.delivery.status).toBe('unavailable');
  expect(readCounter()).toBe(1);
});

it('reports conflict as an explicit delivery failure without rerunning the graph', async () => {
  expect(appendBusInbox({ id: 'graph-observe:run-c', from: 'other', to: 'agent:observer', priority: 'P2', ttl: 60000, body: { schema: 'unrelated' } }, { root }).status).toBe('posted');
  const file = manifest([{ id: 'A', argv: bump() }]);
  expect(await cmdFleetGraphObserve([...base(file, 'run-c'), '--apply', '--json'], { root })).toBe(1);
  const result = last() as { execution: { status: string }; delivery: { status: string } };
  expect(result.execution.status).toBe('complete');
  expect(result.delivery.status).toBe('conflict');
  expect(readCounter()).toBe(1);
});

it('deduplicates a retried helper publish while a rerun still executes again', async () => {
  const file = manifest([{ id: 'A', argv: bump() }]);
  const request = { file, runId: 'run-dup', from: 'agent:runner', to: 'agent:observer', apply: true, timeoutMs: 20000 };
  const first = await graphObservedRun(request, { root });
  expect(first.delivery.status).toBe('posted');
  // Programmatic retry of an already-executed outcome delivers without a child.
  expect(publishGraphTerminalSummary('run-dup', 'agent:runner', 'agent:observer', first.execution, { root }).status).toBe('duplicate');
  expect(readCounter()).toBe(1);
  // Reusing the run-id re-executes: dedupe is transport-only, not idempotence.
  const second = await graphObservedRun(request, { root });
  expect(second.delivery.status).toBe('duplicate');
  expect(readCounter()).toBe(2);
});

it('resolves the convention dispatch module and export name', () => {
  expect(resolveFleetSubcommand('graph-observe')).toEqual({ module: './fleet-graph-observe.js', exportName: 'cmdFleetGraphObserve' });
});
