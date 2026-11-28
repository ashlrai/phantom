import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusWorkLoop } from '../src/cli/fleet-bus-work-loop.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 120_000 });
let base: string, root: string, snapshot: string, prompt: string, counter: string;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const work = (id: string): BusEnvelope => ({ id, from: 'leader', to: 'worker', priority: 'P1', ttl: 120_000,
  body: { kind: 'work', text: 'untrusted message', argv: ['untrusted executable'] } });
const post = (id: string) => expect(appendBusInbox(work(id), { root }).status).toBe('posted');
const count = () => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0;
const worker = (exit = 0, wait = 0) => [process.execPath, '-e',
  `process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(counter)},'x\\n');console.log('fake secret output');setTimeout(()=>process.exit(${exit}),${wait})})`];
const temporary = () => readdirSync(tmpdir()).filter(name => name.startsWith('phantom-bus-work-')).sort();
function run(options: { max?: number; wait?: number; lease?: number; argv?: string[]; owner?: string; to?: string; flags?: string[] } = {}) {
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  const args = ['--to', options.to ?? 'worker', '--owner', options.owner ?? 'one', '--lease-ms', String(options.lease ?? 60000),
    '--wait-ms', String(options.wait ?? 500), '--max-jobs', String(options.max ?? 1), '--snapshot', snapshot,
    '--prompt', prompt, '--root', root, ...(options.flags ?? []), '--', ...(options.argv ?? worker())];
  return cmdFleetBusWorkLoop(args, { stdout: sink, stderr: sink }).then(code => ({ code, output, result: JSON.parse(output) }));
}
function replies() {
  const page = listBusInboxAfter(0, 100, { root });
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  return page.messages.filter(row => row.envelope.to === 'leader').map(row => row.envelope);
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(20); }
  throw new Error('timed out');
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-loop-test-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); counter = join(base, 'counter');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'private fake prompt');
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  vi.stubEnv('TMPDIR', base); vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('waits for real addressed work, processes two sequentially, correlates replies and skips completed rows', async () => {
  const before = temporary();
  const running = run({ max: 2, wait: 30000 });
  await delay(100); post('first'); post('second');
  const result = await running;
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 2 } });
  expect(count()).toBe(2);
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['first', 'second']);
  expect(new Set(replies().map(r => r.id)).size).toBe(2);
  expect(result.output).not.toMatch(/untrusted|private|secret|[a-f0-9]{64}/);
  expect((await run({ wait: 100 })).result).toEqual({ status: 'timeout', completed: 0 });
  expect(count()).toBe(2);
  expect(temporary()).toEqual(before);
});

it('allows two consumers to execute a claim only once', async () => {
  post('once');
  const [a, b] = await Promise.all([run({ argv: worker(0, 300), wait: 10000 }), run({ owner: 'two', wait: 10000 })]);
  expect([a.result.completed, b.result.completed].sort()).toEqual([0, 1]);
  expect(count()).toBe(1);
});

it('releases a failed child, stops before the next job and permits a later retry', async () => {
  const before = temporary(); post('failed'); post('next');
  expect((await run({ max: 2, argv: worker(7) })).result).toEqual({ status: 'failed', completed: 0 });
  expect(count()).toBe(1);
  expect((await run()).result).toEqual({ status: 'max-jobs', completed: 1 });
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['failed', 'failed']);
  expect(temporary()).toEqual(before);
});

it('never settles a successor after renewal loses the original token', async () => {
  const before = temporary(); post('handoff');
  const running = run({ lease: 30000, argv: worker(0, 15000) });
  await until(() => count() === 1);
  const path = join(root, 'bus-work-claims', 'claims.json');
  const rows = JSON.parse(readFileSync(path, 'utf8')) as { token: string }[];
  expect(mutateBusWorkClaim({ action: 'release', id: 'handoff', token: rows[0]!.token, root }).status).toBe('released');
  const successor = mutateBusWorkClaim({ action: 'acquire', id: 'handoff', owner: 'successor', leaseMs: 60000, root });
  expect(successor.status).toBe('acquired');
  expect((await running).result).toEqual({ status: 'failed', completed: 0 });
  expect(mutateBusWorkClaim({ action: 'complete', id: 'handoff', token: successor.token, root }).status).toBe('completed');
  expect(temporary()).toEqual(before);
});

it('interrupts an idle wait and refuses malformed arguments before launch', async () => {
  const started = Date.now(), running = run({ wait: 10_000 });
  await delay(50); process.emit('SIGTERM');
  expect((await running).result).toEqual({ status: 'cancelled', completed: 0 });
  expect(Date.now() - started).toBeLessThan(3000);
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  expect(await cmdFleetBusWorkLoop(['--to', 'worker', '--', process.execPath], { stdout: sink, stderr: sink })).toBe(2);
  expect(count()).toBe(0);
});

it('claims only what the shared read filters admit on every poll and refuses malformed values before launch', async () => {
  const env = (id: string, over: Partial<BusEnvelope> = {}): BusEnvelope => ({ id, from: 'leader', to: 'worker',
    priority: 'P1', ttl: 120_000, body: { kind: 'work', text: `job ${id}` }, ...over });
  const postEnv = (envelope: BusEnvelope) => expect(appendBusInbox(envelope, { root }).status).toBe('posted');
  postEnv(env('p0-urgent', { priority: 'P0', body: { kind: 'work', text: 'urgent deploy' } }));
  postEnv(env('p1-chore'));
  postEnv(env('p1-alpha', { body: { kind: 'work', text: 'ship ALPHA' } }));
  // --priority narrows the claimable band: only the P0 job runs, the P1s wait.
  expect((await run({ max: 1, wait: 5000, flags: ['--priority', 'P0'] })).result).toEqual({ status: 'max-jobs', completed: 1 });
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['p0-urgent']);
  // --contains keeps only the receipt whose summary carries the text.
  expect((await run({ max: 1, wait: 5000, flags: ['--contains', 'alpha'] })).result).toEqual({ status: 'max-jobs', completed: 1 });
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['p0-urgent', 'p1-alpha']);
  // --id targets exactly one named receipt even when an earlier decoy waits.
  postEnv(env('id-decoy')); postEnv(env('id-target'));
  expect((await run({ max: 1, wait: 5000, flags: ['--id', 'id-target'] })).result).toEqual({ status: 'max-jobs', completed: 1 });
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['p0-urgent', 'p1-alpha', 'id-target']);
  // --before bounds the window above: a ceiling before every post's arrival
  // waits honestly to timeout rather than claiming newer work.
  expect((await run({ wait: 200, flags: ['--before', '1d'] })).result).toEqual({ status: 'timeout', completed: 0 });
  // --exclude-from drops every sender spelling of one identity; the peer's
  // job is the only claimable receipt left, and its reply returns to 'peer'.
  postEnv(env('from-peer', { from: 'peer' }));
  expect((await run({ max: 1, wait: 5000, flags: ['--exclude-from', 'leader'] })).result).toEqual({ status: 'max-jobs', completed: 1 });
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['p0-urgent', 'p1-alpha', 'id-target']);
  const peerPage = listBusInboxAfter(0, 100, { root });
  if (peerPage.status !== 'ok') throw new Error('inbox unavailable');
  expect(peerPage.messages.filter(row => row.envelope.to === 'peer').map(row => (row.envelope.body as { inReplyTo: string }).inReplyTo))
    .toEqual(['from-peer']);
  // --topic narrows group-addressed work to one room topic; a mismatched
  // topic waits honestly to timeout.
  postEnv(env('dep-work', { to: 'group:eng:deploy' }));
  expect((await run({ to: 'group:eng:deploy', max: 1, wait: 5000, flags: ['--topic', 'general'] })).result)
    .toEqual({ status: 'timeout', completed: 0 });
  expect((await run({ to: 'group:eng:deploy', max: 1, wait: 5000, flags: ['--topic', 'deploy', '--channel', 'eng'] })).result)
    .toEqual({ status: 'max-jobs', completed: 1 });
  expect(replies().map(r => (r.body as { inReplyTo: string }).inReplyTo)).toEqual(['p0-urgent', 'p1-alpha', 'id-target', 'dep-work']);
  // Malformed filter values are invalid before the first launch.
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  for (const flags of [['--priority', 'P9'], ['--since', 'bogus'], ['--before', 'bogus'], ['--contains', '   '],
    ['--topic', 'Bad Name'], ['--topic', 'deploy:extra'], ['--id', 'has space'], ['--channel', 'Bad Name'],
    ['--from', 'bad sender'], ['--exclude-from', 'bad sender']]) {
    expect(await cmdFleetBusWorkLoop(['--to', 'worker', '--owner', 'bad', '--lease-ms', '60000', '--wait-ms', '100',
      '--max-jobs', '1', '--snapshot', snapshot, '--prompt', prompt, '--root', root, ...flags, '--', ...worker()],
    { stdout: sink, stderr: sink })).toBe(2);
  }
  expect(count()).toBe(5);
});

it('writes a private request while running and honors the runs stop switch', async () => {
  post('private');
  const before = temporary();
  const running = run({ argv: worker(0, 600) });
  await until(() => temporary().some(name => !before.includes(name)));
  const dir = temporary().find(name => !before.includes(name))!;
  expect(statSync(join(tmpdir(), dir, 'request.json')).mode & 0o777).toBe(0o600);
  expect((await running).result.completed).toBe(1);
  expect(temporary()).toEqual(before);
  post('blocked'); writeFileSync(join(base, 'runs', 'ORCH_OFF'), '');
  expect((await run()).result).toEqual({ status: 'failed', completed: 0 });
  expect(count()).toBe(1);
});
