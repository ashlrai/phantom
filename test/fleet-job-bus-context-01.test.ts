import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { inspectBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';

let root: string;
let runs: string;
let output: string[];
let errors: string[];
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'job-bus-'));
  runs = join(root, 'runs');
  await mkdir(runs);
  await writeFile(join(runs, 'JOB1.launch'), 'launched JOB1 main pid 123 base abcdef0\n');
  output = []; errors = []; now = 1000;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup() {
  const options = { root: join(root, 'fleet'), now: () => now };
  const inspect = vi.fn(() => inspectBusInbox(options));
  const list = vi.fn((after?: number, limit?: number) => listBusInboxAfter(after, limit, options));
  const deps = { detail: (id: string) => getFleetJobDetail(id, { runsDir: runs }), changes: getFleetJobChanges,
    inspectBus: inspect, listBus: list,
    output: { log: (s: string) => output.push(s), stdout: (s: string) => output.push(s), stderr: (s: string) => errors.push(s) } };
  const rows: Array<{ cursor: number; receivedAt: number; envelope: unknown }> = [];
  const post = (id: string, from: string, to: string, body: unknown, ttl = 10000) => {
    rows.push({ cursor: rows.length + 1, receivedAt: now, envelope: { id, from, to, body, ttl, priority: 'P1' } });
  };
  const flush = async () => {
    if (!rows.length) return;
    const directory = join(options.root, 'bus-inbox');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'messages.json'), JSON.stringify(rows), { mode: 0o600 });
  };
  const run = async (...args: string[]) => {
    output = []; errors = [];
    await flush();
    const code = await cmdFleetJobRead(args, deps);
    return { code, result: output.length ? JSON.parse(output[0]!) : undefined };
  };
  return { options, inspect, list, deps, post, run, flush };
}

describe('fleet job retained bus context', () => {
  it('filters exact labels, marks broadcasts, omits expired and unrelated bodies, and scrubs output', async () => {
    const { post, run } = setup();
    post('in', 'mason', 'JOB1', { text: 'incoming' });
    post('out', 'JOB1', 'mason', { text: 'outgoing' });
    post('all', 'other', 'all', { text: 'broadcast' });
    post('near1', 'mason', 'JOB10', { text: 'private unrelated one' });
    post('near2', 'xJOB1', 'mason', { text: 'private unrelated two' });
    post('expired', 'mason', 'JOB1', { text: 'expired body' }, 1);
    post('safe', 'mason', 'JOB1', { text: 'token=synthetic_fixture_value_123456' });
    now += 2;
    const { code, result } = await run('JOB1', '--bus', '--json');
    expect(code).toBe(0);
    expect(result).toMatchObject({ schema: 'fleet.job.bus.v1', job: 'JOB1', source: 'available', scannedThrough: 7, hasMore: false, truncated: false });
    expect(result.messages.map((row: { envelope: { id: string }; category: string }) => [row.envelope.id, row.category]))
      .toEqual([['in', 'direct'], ['out', 'direct'], ['all', 'broadcast'], ['safe', 'direct']]);
    expect(JSON.stringify(result)).not.toMatch(/private unrelated|expired body|synthetic_fixture_value/);
  });

  it('scans past a full unrelated page and resumes without skipping matches', async () => {
    const { post, run, list } = setup();
    for (let i = 0; i < 101; i++) post(`other-${i}`, 'other', 'JOB10', 'unrelated');
    post('first', 'mason', 'JOB1', 'first match');
    post('second', 'JOB1', 'mason', 'second match');
    const first = await run('JOB1', '--bus', '--limit', '1', '--json');
    expect(first.code).toBe(0);
    expect(first.result).toMatchObject({ scannedThrough: 102, hasMore: true, truncated: true, messages: [{ envelope: { id: 'first' } }] });
    expect(list).toHaveBeenCalledTimes(2);
    const second = await run('JOB1', '--bus', '--after', String(first.result.scannedThrough), '--limit', '1', '--json');
    expect(second.result).toMatchObject({ scannedThrough: 103, hasMore: false, truncated: false, messages: [{ envelope: { id: 'second' } }] });
  });

  it('reports missing and unavailable storage and does not leak unavailable details', async () => {
    const { options, run } = setup();
    expect((await run('JOB1', '--bus', '--json')).result).toMatchObject({ source: 'missing', messages: [], scannedThrough: 0 });
    await mkdir(options.root);
    await chmod(options.root, 0o755);
    const unavailable = await run('JOB1', '--bus', '--json');
    expect(unavailable.code).toBe(1);
    expect(unavailable.result).toMatchObject({ source: 'unavailable', messages: [] });
    expect(JSON.stringify(unavailable.result)).not.toContain(root);
  });

  it('rejects unknown and invalid jobs before any inbox access, and rejects invalid combinations', async () => {
    const { inspect, list, run } = setup();
    for (const args of [
      ['ABSENT', '--bus'], ['../bad', '--bus'], ['JOB1\n', '--bus'],
      ['JOB1', '--bus', '--watch'], ['JOB1', '--bus', '--log'], ['JOB1', '--bus', '--prompt'],
      ['JOB1', '--bus', '--changes'], ['JOB1', '--bus', '--notes'], ['JOB1', '--bus', '--require-published', '--json'],
      ['JOB1', '--after', '1'], ['JOB1', '--limit', '1'], ['JOB1', '--bus', '--limit', '0'],
      ['JOB1', '--bus', '--limit', '101'], ['JOB1', '--bus', '--after', '-1'], ['JOB1', '--bus', '--after', '1', '--after', '2'],
    ]) expect((await run(...args)).code).not.toBe(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect((await run('JOB1', '--bus', '--after', '1')).code).toBe(2);
  });

  it('prints the same sanitized categorized payload in text mode', async () => {
    const { post, deps, flush } = setup();
    post('text', 'mason', 'JOB1', { text: 'token=synthetic_fixture_value_123456' });
    await flush();
    expect(await cmdFleetJobRead(['JOB1', '--bus'], deps)).toBe(0);
    expect(output.join('')).toContain('"category": "direct"');
    expect(output.join('')).not.toContain('synthetic_fixture_value');
  });
});
