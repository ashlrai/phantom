import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetGraphPost } from '../src/cli/fleet-graph-post.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const envelope = (id: string) => ({ id: `message-${id}`, from: 'planner', to: 'worker', priority: 'P1', ttl: 60000, body: { work: id } });
const task = (id: string, dependsOn: string[] = []) => ({ id, dependsOn, envelope: envelope(id) });
const graph = () => ({ batchId: 'batch-1', completed: [] as string[], tasks: [task('A'), task('B', ['A'])] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-post-'));
  roots.push(root);
  const store = join(root, 'store'), file = join(root, 'graph.json');
  const options = { root: store };
  async function run(input: unknown, apply = true, json = true) {
    writeFileSync(file, typeof input === 'string' ? input : JSON.stringify(input), { mode: 0o600 });
    let output = '';
    const code = await cmdFleetGraphPost(['--file', file, ...(apply ? ['--apply'] : []), ...(json ? ['--json'] : [])],
      options, { emit: text => { output = text; } });
    return { code, output, receipt: json ? JSON.parse(output) : null };
  }
  return { root, store, options, run, snapshot: () => readFileSync(join(store, 'bus-inbox/messages.json'), 'utf8') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('previews without creating storage and distinguishes delivery from execution', async () => {
  const f = fixture();
  const result = await f.run(graph(), false);
  expect(result.code).toBe(0);
  expect(result.receipt).toMatchObject({ status: 'preview', ready: ['A'], blocked: ['B'], accepted: [], execution: 'not-started' });
  expect(existsSync(f.store)).toBe(false);
  expect((await f.run(graph(), false, false)).output).toContain('job execution not started');
});

it('delivers A then only B after explicit completion, and exact replay dedupes', async () => {
  const f = fixture(), input = graph();
  expect((await f.run(input)).receipt.accepted).toEqual([{ taskId: 'A', id: 'message-A', status: 'posted', cursor: 1 }]);
  const first = f.snapshot();
  expect((await f.run(input)).receipt.accepted[0]).toMatchObject({ taskId: 'A', status: 'duplicate' });
  expect(f.snapshot()).toBe(first);
  input.completed = ['A'];
  expect((await f.run(input)).receipt).toMatchObject({ ready: ['B'], accepted: [{ taskId: 'B', status: 'posted', cursor: 2 }] });
  expect(listBusInboxAfter(0, 100, f.options)).toMatchObject({ status: 'ok', nextCursor: 2,
    messages: [{ envelope: { id: 'message-A' } }, { envelope: { id: 'message-B' } }] });
}, 30000);

it('validates the entire graph including completed and blocked nodes before writes', async () => {
  const f = fixture();
  const cases = [
    { ...graph(), tasks: [task('A'), task('A')] },
    { ...graph(), tasks: [task('A'), { ...task('B'), envelope: envelope('A') }] },
    { ...graph(), completed: ['unknown'] },
    { ...graph(), completed: ['A'], tasks: [task('A', ['missing'])] },
    { ...graph(), completed: ['A'], tasks: [task('A', ['A'])] },
    { ...graph(), completed: ['A', 'B'], tasks: [task('A', ['B']), task('B', ['A'])] },
    { ...graph(), tasks: [task('A'), { ...task('B', ['A']), envelope: { ...envelope('B'), ttl: 0 } }] },
    { ...graph(), extra: true }, { ...graph(), tasks: Array.from({ length: 257 }, (_, i) => task(String(i))) },
    '[', ' '.repeat(256 * 1024 + 1),
  ];
  for (const input of cases) {
    expect((await f.run(input)).code).toBe(2);
    expect(existsSync(f.store)).toBe(false);
  }
});

it('refuses an oversized frontier without truncating and handles an empty frontier without storage', async () => {
  const f = fixture();
  expect((await f.run({ ...graph(), tasks: Array.from({ length: 33 }, (_, i) => task(String(i))) })).code).toBe(2);
  // An unusable store proves all-complete never calls the batch transport.
  writeFileSync(f.store, 'storage refusal');
  const result = await f.run({ ...graph(), completed: ['A', 'B'] });
  expect(result.code).toBe(0);
  expect(result.receipt).toMatchObject({ ready: [], accepted: [], complete: true });
  expect(readFileSync(f.store, 'utf8')).toBe('storage refusal');
});

it('reports a genuine storage refusal and maps failed and unattempted tasks', async () => {
  const f = fixture();
  writeFileSync(f.store, 'not a directory');
  const result = await f.run({ ...graph(), tasks: [task('A'), task('B')] });
  expect(result.code).toBe(1);
  expect(result.receipt).toMatchObject({ complete: false, accepted: [],
    failure: { taskId: 'A', index: 0, status: 'unavailable' }, unattempted: [{ taskId: 'B', id: 'message-B' }] });
});

it('preserves the accepted prefix when the real bus refuses a conflicting message', async () => {
  const f = fixture();
  expect(appendBusInbox({ ...envelope('B'), body: 'previous request' }, f.options).status).toBe('posted');
  const result = await f.run({ ...graph(), tasks: [task('A'), task('B'), task('C')] });
  expect(result.code).toBe(1);
  expect(result.receipt).toMatchObject({ complete: false, accepted: [{ taskId: 'A', status: 'posted' }],
    failure: { taskId: 'B', index: 1, status: 'conflict' }, unattempted: [{ taskId: 'C', id: 'message-C' }] });
  expect(listBusInboxAfter(0, 100, f.options)).toMatchObject({ status: 'ok', nextCursor: 2 });
  const before = f.snapshot();
  await f.run({ ...graph(), completed: ['unknown'] });
  await f.run(graph(), false);
  expect(f.snapshot()).toBe(before);
}, 30000);

it('refuses an unavailable input file and unknown options without bus writes', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'directory'));
  for (const args of [['--file', join(f.root, 'missing')], ['--file', join(f.root, 'directory')], ['--apply', '--unknown']]) {
    expect(await cmdFleetGraphPost(args, f.options, { emit: () => undefined })).toBe(2);
  }
  expect(existsSync(f.store)).toBe(false);
});
