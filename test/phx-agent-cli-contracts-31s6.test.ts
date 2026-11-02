import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const graph = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => graph);
import { cmdGraph } from '../src/cli/graph.js';

let root: string;
let stdout: string[];
let stderr: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-cli-contracts-'));
  stdout = []; stderr = '';
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { stdout.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const output = () => JSON.parse(stdout.at(-1)!);
const envelope = { id: 'fake-1', from: 'fake-a', to: 'fake-b', priority: 'P1', ttl: 1000, body: { task: 'fake' } };

it('posts, resumes and reports contention and conflicts with separate streams', async () => {
  const options = { root, now: () => 100 };
  const post = (body: unknown) => cmdCommsBus(['post', '--file', '-'], options, { stdin: Readable.from([JSON.stringify(body)]) });
  expect(await post(envelope)).toBe(0);
  expect(output()).toEqual({ status: 'posted', id: 'fake-1', cursor: 1 });
  expect(await post(envelope)).toBe(0);
  expect(output()).toEqual({ status: 'duplicate', id: 'fake-1', cursor: 1 });
  expect(await post({ ...envelope, body: 'different fake' })).toBe(1);
  expect(output()).toEqual({ status: 'conflict' });
  const lock = acquireLocalStoreLock(join(root, 'bus-inbox', 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  expect(lock).not.toBeNull();
  try {
    expect(await post({ ...envelope, id: 'fake-2' })).toBe(1);
    expect(output()).toEqual({ status: 'retryable' });
  } finally { releaseLocalStoreLock(lock); }
  expect(await cmdCommsBus(['read', '--after', '0', '--to', 'fake-other'], options)).toBe(0);
  expect(output()).toEqual({ status: 'ok', messages: [], nextCursor: 1 });
  expect(await cmdCommsBus(['read', '--after', '1'], options)).toBe(0);
  expect(output()).toEqual({ status: 'ok', messages: [], nextCursor: 1 });
  expect(await cmdCommsBus(['read', '--limit', '0'], options)).toBe(2);
  expect(output()).toEqual({ status: 'invalid' });
  expect(stderr).toBe('');
}, 60_000);

it('watch retries a retryable poll without emitting it or advancing the cursor', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const list = vi.fn().mockReturnValueOnce({ status: 'retryable' })
    .mockReturnValueOnce({ status: 'ok', messages: [], nextCursor: 3 });
  const run = cmdCommsBus(['watch', '--after', '2', '--interval-ms', '100'], { root }, { list, signal: controller.signal });
  expect(stdout).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(list.mock.calls.map(call => call[0])).toEqual([2, 2]);
  expect(output()).toEqual({ status: 'ok', messages: [], nextCursor: 3 });
  controller.abort();
  expect(await run).toBe(0);
  expect(stderr).toBe('');
});

it('distinguishes missing inbox evidence, stdin post, and usage errors', async () => {
  const command = createCommsInboxCommand({ runsDir: join(root, 'runs'), stdin: Readable.from(['Fake handoff.']) });
  expect(await command(['read', '--json'])).toBe(0);
  expect(output()).toEqual({ sourceState: 'missing', entries: [] });
  expect(await command(['post', '--file', '-'])).toBe(0);
  expect(output()).toMatchObject({ ok: true, ack: { channel: 'cli', status: 'accepted' } });
  expect(await command(['read', '--source', 'cli'])).toBe(0);
  expect(output()).toMatchObject({ sourceState: 'healthy', entries: [{ source: 'cli', text: 'Fake handoff.' }] });
  expect(await command(['post'])).toBe(2);
  expect(output()).toEqual({ status: 'invalid' });
  expect(stderr).toBe('');
});

it('puts graph JSON unavailable and usage errors on stdout', async () => {
  graph.loadGraph.mockResolvedValue({ status: 'unavailable' });
  expect(await cmdGraph(['status', '--json'])).toBe(1);
  expect(output()).toMatchObject({ schemaVersion: 1, command: 'status', status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
  expect(await cmdGraph(['neighbors', '--json'])).toBe(2);
  expect(output()).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
  expect(stderr).toBe('');
});

it('keeps missing ledger and runs evidence distinct from reader exceptions', async () => {
  const missing = join(root, 'missing');
  const ledger = () => readResourceLedger({ runsDir: missing, personalCodexHome: join(root, 'fake-personal') });
  expect(await cmdResourceLedger(['--json'], ledger)).toBe(0);
  expect(output()).toMatchObject({ v: 1, sources: { status: 'missing', apiSpend: 'missing', jobs: 'missing' }, asOf: null, apiSpend: null });
  const readers = {
    runs: () => readFleetRunsDirState({ runsDir: missing }),
    journal: vi.fn(), parked: vi.fn(),
  };
  expect(await cmdFleetRunsRead('runs', ['--json'], readers)).toBe(0);
  expect(output()).toMatchObject({ v: 1, sourceState: 'missing', runsDirPresent: false });
  stdout = [];
  const unavailable = async (): Promise<never> => { throw new Error('fake private detail'); };
  expect(await cmdResourceLedger(['--json'], unavailable)).toBe(1);
  expect(await cmdFleetRunsRead('runs', ['--json'], { ...readers, runs: unavailable })).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toBe('Unable to read resource ledger.\nerror: fleet runs unavailable\n');
});
