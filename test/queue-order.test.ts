import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdQueue } from '../src/cli/queue.js';
import { VERSE_FLEET_QUEUE_ORDER_PATH as PATH, isQueueAction, isQueueOrder } from '../src/core/queue/order-types.js';
import { QueueSteerError, queueOrderText, readQueueOrder, steerQueue, type QueueOrderOptions, type TakeReadyLock } from '../src/core/queue/order.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date(2026, 10, 17, 16, 1, 10);
let runs: string, queue: string, ready: string;
const row = (id: string, lane = 'codex-personal', repo = 'phantom') => `${id}\t${repo}\t${lane}\tmid\t${queue}/prompts/${id}.md\textra`;
const read = (name: string) => readFile(join(queue, name), 'utf8');
const ids = async () => (await read('ready.tsv')).trimEnd().split('\n').map(line => line.split('\t')[0]);
/** An in-process stand-in for queue/ready.lock: one holder at a time, in arrival order. */
function fakeLock(quiet = true): TakeReadyLock {
  let tail = Promise.resolve();
  return async () => {
    const before = tail;
    let free!: () => void;
    tail = new Promise<void>(done => { free = done; });
    await before;
    return { quiet, release: async () => free() };
  };
}
const opts = (extra: QueueOrderOptions = {}): QueueOrderOptions => ({ runsDir: runs, now: () => NOW, lock: fakeLock(), verifyMs: 0, sleep: async () => {}, ...extra });
let START: string;

beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'queue-order-')); queue = join(runs, 'queue'); ready = join(queue, 'ready.tsv');
  await mkdir(join(queue, 'prompts'), { recursive: true });
  START = [row('RQ-PHX-AREAC541'), row('RQ-ONE', 'claude'), row('RQ-PHX-HELDC530', 'PARKED-BYHAND.codex-local'), row('RQ-PHX-AREAC544'), row('RQ-TWO', 'devin', 'locus')].join('\n') + '\n';
  await writeFile(ready, START);
  await writeFile(join(queue, 'router-queue.md'), ['# Router queue', '- CLAIMED 09:15 dispatchd RQ-ONE (P1, repo=phantom): one.', '- READY RQ-LATER (repo=phantom): later.', ''].join('\n'));
  await writeFile(join(queue, 'prompts', 'RQ-ONE.md'), 'prompt');
  await utimes(join(queue, 'prompts', 'RQ-ONE.md'), NOW, new Date(NOW.getTime() - 600_000));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(runs, { recursive: true, force: true }); });

describe('readQueueOrder', () => {
  it('lists queued jobs in launch order with a versioned schema, leaving parked rows out', async () => {
    const order = await readQueueOrder(opts());
    expect(isQueueOrder(order)).toBe(true);
    expect(order).toMatchObject({ schema: 'queue.order.v1', version: 1, count: 4, parked: 1, generatedAt: NOW.toISOString() });
    expect(order.lanes).toEqual(['claude', 'codex-local', 'codex-personal', 'devin']);
    expect(order.jobs).toEqual([
      { position: 1, id: 'RQ-PHX-AREAC541', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: null, family: 'RQ-PHX-AREA', supersededBy: 'RQ-PHX-AREAC544' },
      { position: 2, id: 'RQ-ONE', repo: 'phantom', lane: 'claude', tier: 'mid', ageSeconds: 600, family: null, supersededBy: null },
      { position: 3, id: 'RQ-PHX-AREAC544', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: null, family: 'RQ-PHX-AREA', supersededBy: null },
      { position: 4, id: 'RQ-TWO', repo: 'locus', lane: 'devin', tier: 'mid', ageSeconds: null, family: null, supersededBy: null },
    ]);
    expect(queueOrderText(order)).toEqual(['4 queued jobs, next to launch first. 1 parked.',
      '  1  RQ-PHX-AREAC541  phantom  codex-personal  mid  age unknown  replaced by RQ-PHX-AREAC544', '  2  RQ-ONE  phantom  claude  mid  10m',
      '  3  RQ-PHX-AREAC544  phantom  codex-personal  mid  age unknown', '  4  RQ-TWO  locus  devin  mid  age unknown']);
  });
  it('says the queue is unavailable when there is no queue file', async () => {
    await rm(ready);
    await expect(readQueueOrder(opts())).rejects.toMatchObject({ code: 'queue-missing', status: 503 });
  });
  it('lists a spec-less row by its router-queue envelope lane, not the column', async () => {
    // The market resolves a five-column row's spec from the matching
    // router-queue.md envelope: its lane attr is the hint and the lane cell
    // is never consulted, so the list names the envelope's lane.
    const specLess = (id: string, lane: string) => `${id}\tphantom\t${lane}\tmid\t${queue}/prompts/${id}.md`;
    await writeFile(join(queue, 'router-queue.md'), [
      '- READY RQ-ENV (P1, preferred_lane=claude): pinned.',
      '- READY RQ-OPEN (P2): open.',
      '',
    ].join('\n'));
    await writeFile(ready, [specLess('RQ-ENV', 'codex-personal'), specLess('RQ-OPEN', 'devin'), specLess('RQ-BARE', 'claude')].join('\n') + '\n');
    const order = await readQueueOrder(opts());
    expect(order.jobs.map(job => [job.id, job.lane])).toEqual([
      ['RQ-ENV', 'claude'],   // envelope pin beats the codex-personal column
      ['RQ-OPEN', 'devin'],   // lane-open envelope: the column stands
      ['RQ-BARE', 'claude'],  // no envelope: the column stands
    ]);
  });
});

describe('steerQueue', () => {
  it('top moves the row to the front, keeps a backup and logs the change', async () => {
    const report = await steerQueue({ action: 'top', id: 'RQ-TWO' }, opts({ by: 'desktop' }));
    expect(isQueueAction(report)).toBe(true);
    expect(report).toEqual({ schema: 'queue.action.v1', version: 1, action: 'top', id: 'RQ-TWO', dryRun: false, changed: true, verified: true,
      from: { position: 4, of: 4, lane: 'devin' }, to: { position: 1, lane: 'devin' }, backup: 'ready.tsv.bak', archive: null,
      message: 'Moved RQ-TWO to the top (was 4 of 4).' });
    expect(await ids()).toEqual(['RQ-TWO', 'RQ-PHX-AREAC541', 'RQ-ONE', 'RQ-PHX-HELDC530', 'RQ-PHX-AREAC544']);
    expect(await read('ready.tsv.bak')).toBe(START);
    expect(await read('dispatch-events.log')).toBe('2026-11-17 16:01:10 QUEUE_TOP RQ-TWO src=phm-queue by=desktop\n');
    expect(await steerQueue({ action: 'top', id: 'RQ-TWO' }, opts())).toMatchObject({ changed: false, verified: null, backup: null, message: 'RQ-TWO is already first.' });
  });
  it('lane rewrites only the lane column', async () => {
    const report = await steerQueue({ action: 'lane', id: 'RQ-ONE', lane: 'devin' }, opts());
    expect(report).toMatchObject({ changed: true, verified: true, from: { position: 2, lane: 'claude' }, to: { position: 2, lane: 'devin' }, message: 'Moved RQ-ONE from claude to devin.' });
    expect(await read('ready.tsv')).toBe(START.replace(row('RQ-ONE', 'claude'), row('RQ-ONE', 'devin')));
    expect(await steerQueue({ action: 'lane', id: 'RQ-ONE', lane: 'devin' }, opts())).toMatchObject({ changed: false, message: 'RQ-ONE is already on devin.' });
  });
  it('lane moves the market hint: the spec preferred_lane moves with the column', async () => {
    // Restock rows carry a requirements spec whose preferred_lane outranks the
    // lane column; a column-only rewrite left the market's hint unmoved.
    const spec = (pref: string | null) => JSON.stringify({ needs: ['gh'], preferred_lane: pref, min_tier: 'work' });
    const pinned = `RQ-PINNED\tphantom\tcodex-personal\tmid\t${queue}/prompts/RQ-PINNED.md\t${spec('claude')}`;
    const open = `RQ-OPEN\tphantom\tclaude\tmid\t${queue}/prompts/RQ-OPEN.md\t${spec(null)}`;
    const bare = `RQ-BARE\tphantom\tclaude\tmid\t${queue}/prompts/RQ-BARE.md`;
    await writeFile(ready, `${pinned}\n${open}\n${bare}\n`);
    const report = await steerQueue({ action: 'lane', id: 'RQ-PINNED', lane: 'devin' }, opts());
    expect(report).toMatchObject({ changed: true, verified: true, from: { lane: 'claude' }, to: { lane: 'devin' }, message: 'Moved RQ-PINNED from claude to devin.' });
    expect(await read('ready.tsv')).toBe(`${pinned.replace('codex-personal', 'devin').replace(spec('claude'), spec('devin'))}\n${open}\n${bare}\n`);
    // explicit null is the open hint: steering pins the lane inside the spec too
    await steerQueue({ action: 'lane', id: 'RQ-OPEN', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toContain(`RQ-OPEN\tphantom\tdevin\tmid\t${queue}/prompts/RQ-OPEN.md\t${spec('devin')}`);
    // a spec-less row with no matching envelope has no requirements cell to
    // sync: the column is the hint
    await steerQueue({ action: 'lane', id: 'RQ-BARE', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toContain(`RQ-BARE\tphantom\tdevin\tmid\t${queue}/prompts/RQ-BARE.md\n`);
  });
  it('lane moves the market hint on spec-less rows: the router-queue envelope spec materializes', async () => {
    // A five-column row's requirements come from its router-queue.md
    // envelope, which the market reads instead of the lane column; a
    // column-only rewrite would leave the job on the envelope's lane —
    // permanently for a local pin the market enforces.
    const specLess = (id: string, lane: string) => `${id}\tphantom\t${lane}\tmid\t${queue}/prompts/${id}.md`;
    await writeFile(join(queue, 'router-queue.md'), [
      '# Router queue',
      '- READY RQ-ENV (P1, preferred_lane=claude, repo=phantom): pinned.',
      '- READY RQ-ALT (lane=codex-local): local pin.',
      '- READY RQ-OPEN (P2, repo=phantom): open.',
      '- READY RQ-BAD (exclusive=maybe): malformed.',
      '',
    ].join('\n'));
    await writeFile(ready, [specLess('RQ-ENV', 'codex-personal'), specLess('RQ-ALT', 'devin'), specLess('RQ-OPEN', 'claude'), specLess('RQ-BAD', 'claude'), specLess('RQ-BARE2', 'claude')].join('\n') + '\n');
    // The report names the lane the market prefers — the envelope's, not the column's.
    const report = await steerQueue({ action: 'lane', id: 'RQ-ENV', lane: 'devin' }, opts());
    expect(report).toMatchObject({ changed: true, verified: true, from: { lane: 'claude' }, to: { lane: 'devin' }, message: 'Moved RQ-ENV from claude to devin.' });
    expect(await read('ready.tsv')).toContain(`RQ-ENV\tphantom\tdevin\tmid\t${queue}/prompts/RQ-ENV.md\t{"preferred_lane":"devin","priority":"P1"}\n`);
    // A local pin moves too: the materialized spec overrides preferred_lane.
    await steerQueue({ action: 'lane', id: 'RQ-ALT', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toContain(`RQ-ALT\tphantom\tdevin\tmid\t${queue}/prompts/RQ-ALT.md\t{"preferred_lane":"devin"}\n`);
    // An envelope naming no lane attr is lane-open: steering pins the lane.
    await steerQueue({ action: 'lane', id: 'RQ-OPEN', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toContain(`RQ-OPEN\tphantom\tdevin\tmid\t${queue}/prompts/RQ-OPEN.md\t{"preferred_lane":"devin","priority":"P2"}\n`);
    // A malformed envelope leaves the row dead to the market either way:
    // the steer rewrites the column only, as it always did.
    await steerQueue({ action: 'lane', id: 'RQ-BAD', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toContain(`RQ-BAD\tphantom\tdevin\tmid\t${queue}/prompts/RQ-BAD.md\n`);
    // No matching envelope: the column is the hint, nothing materializes.
    await steerQueue({ action: 'lane', id: 'RQ-BARE2', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toContain(`RQ-BARE2\tphantom\tdevin\tmid\t${queue}/prompts/RQ-BARE2.md\n`);
    // Once materialized the spec cell is authoritative: steering again is a no-op.
    expect(await steerQueue({ action: 'lane', id: 'RQ-ENV', lane: 'devin' }, opts())).toMatchObject({ changed: false, message: 'RQ-ENV is already on devin.' });
  });
  it('lane is not a no-op when only the spec disagrees, and leaves a matching spec cell untouched', async () => {
    // The column already says devin but the spec still prefers claude: the
    // market would keep the job on claude, so the steer must rewrite the spec.
    await writeFile(ready, `RQ-SAME\tphantom\tdevin\tmid\t${queue}/prompts/RQ-SAME.md\t${JSON.stringify({ preferred_lane: 'claude' })}\n`);
    const moved = await steerQueue({ action: 'lane', id: 'RQ-SAME', lane: 'devin' }, opts());
    expect(moved).toMatchObject({ changed: true, from: { lane: 'claude' }, to: { lane: 'devin' }, message: 'Moved RQ-SAME from claude to devin.' });
    expect(await read('ready.tsv')).toBe(`RQ-SAME\tphantom\tdevin\tmid\t${queue}/prompts/RQ-SAME.md\t${JSON.stringify({ preferred_lane: 'devin' })}\n`);
    expect(await steerQueue({ action: 'lane', id: 'RQ-SAME', lane: 'devin' }, opts())).toMatchObject({ changed: false, message: 'RQ-SAME is already on devin.' });
    // A spec that already prefers the target keeps its original text byte-for-byte.
    const spaced = '{ "preferred_lane": "devin", "needs": ["gh"] }';
    await writeFile(ready, `RQ-FMT\tphantom\tclaude\tmid\t${queue}/prompts/RQ-FMT.md\t${spaced}\n`);
    await steerQueue({ action: 'lane', id: 'RQ-FMT', lane: 'devin' }, opts());
    expect(await read('ready.tsv')).toBe(`RQ-FMT\tphantom\tdevin\tmid\t${queue}/prompts/RQ-FMT.md\t${spaced}\n`);
  });
  it('drop archives the row instead of deleting it and marks its router line', async () => {
    const report = await steerQueue({ action: 'drop', id: 'RQ-ONE' }, opts());
    expect(report).toMatchObject({ changed: true, verified: true, to: { position: null, lane: 'claude' }, backup: 'ready.tsv.bak', archive: 'dropped.tsv',
      message: 'Dropped RQ-ONE (was 2 of 4). Its row is kept in queue/dropped.tsv.' });
    expect(await read('ready.tsv')).toBe(START.replace(`${row('RQ-ONE', 'claude')}\n`, ''));
    expect(await read('dropped.tsv')).toBe(`${row('RQ-ONE', 'claude')}\n`);
    expect(await read('ready.tsv.bak')).toBe(START);
    expect(await read('router-queue.md')).toContain('- DROPPED 09:15 dispatchd RQ-ONE (P1, repo=phantom): one.\n- READY RQ-LATER');
    expect(await read('dispatch-events.log')).toContain('QUEUE_DROPPED RQ-ONE src=phm-queue by=cli');
  });
  it.each([{ action: 'top', id: 'RQ-TWO' }, { action: 'lane', id: 'RQ-ONE', lane: 'devin' }, { action: 'drop', id: 'RQ-ONE' }] as const)('--dry-run $action leaves every file unchanged', async request => {
    const before = (await readdir(queue)).sort();
    const report = await steerQueue({ ...request, dryRun: true }, opts());
    expect(report).toMatchObject({ dryRun: true, changed: true, verified: null, backup: null, archive: null });
    expect(report.message).toMatch(/^Would (move|drop) /);
    expect(await read('ready.tsv')).toBe(START);
    expect((await readdir(queue)).sort()).toEqual(before);
  });
  it('keeps a row another writer appends under the same lock', async () => {
    const lock = fakeLock();
    const append = async () => { const held = await lock(queue); await appendFile(ready, `${row('RQ-NEW')}\n`); await held.release(); };
    await Promise.all([append(), steerQueue({ action: 'top', id: 'RQ-TWO' }, opts({ lock })), append()]);
    expect(await ids()).toEqual(['RQ-TWO', 'RQ-PHX-AREAC541', 'RQ-ONE', 'RQ-PHX-HELDC530', 'RQ-PHX-AREAC544', 'RQ-NEW', 'RQ-NEW']);
  });
  it('waits for the real ready.lock and edits the text the other holder left', async () => {
    // A producer holds the flock, appends after a pause and lets go: the same steps restock.py takes.
    const holder = spawn('python3', ['-c', `import fcntl,sys,time
lock=open(sys.argv[1],'a'); fcntl.flock(lock,fcntl.LOCK_EX); print('held',flush=True); time.sleep(0.4)
open(sys.argv[2],'a').write(sys.argv[3]+'\\n')`, join(queue, 'ready.lock'), ready, row('RQ-NEW')], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(done => holder.stdout.once('data', done));
    const report = await steerQueue({ action: 'drop', id: 'RQ-ONE' }, { runsDir: runs, now: () => NOW });
    expect(report).toMatchObject({ changed: true, verified: true });
    expect(await ids()).toEqual(['RQ-PHX-AREAC541', 'RQ-PHX-HELDC530', 'RQ-PHX-AREAC544', 'RQ-TWO', 'RQ-NEW']);
    expect(await read('ready.tsv.bak')).toBe(`${START}${row('RQ-NEW')}\n`);
  });
  it('re-applies an edit a running dispatcher wrote over, and says so when it cannot', async () => {
    let undo = 1;
    const sleep = async () => { if (undo-- > 0) await writeFile(ready, START); };
    expect(await steerQueue({ action: 'top', id: 'RQ-TWO' }, opts({ lock: fakeLock(false), sleep }))).toMatchObject({ changed: true, verified: true });
    expect((await ids())[0]).toBe('RQ-TWO');
    await writeFile(ready, START);
    const lost = await steerQueue({ action: 'drop', id: 'RQ-ONE' }, opts({ lock: fakeLock(false), attempts: 2, sleep: () => writeFile(ready, START) }));
    expect(lost).toMatchObject({ changed: true, verified: false, message: 'Dropped RQ-ONE (was 2 of 4). Its row is kept in queue/dropped.tsv. The dispatcher wrote the old queue back; run it again.' });
    expect(await read('dropped.tsv')).toBe(`${row('RQ-ONE', 'claude')}\n`);
  });
  it('refuses unknown jobs, parked jobs, closed lanes and a missing queue without writing', async () => {
    await expect(steerQueue({ action: 'top', id: 'RQ-NOPE' }, opts())).rejects.toMatchObject({ code: 'job-not-found', status: 404 });
    await expect(steerQueue({ action: 'drop', id: 'RQ-PHX-HELDC530' }, opts())).rejects.toMatchObject({ code: 'job-not-found' });
    await expect(steerQueue({ action: 'lane', id: 'RQ-ONE', lane: 'nowhere' }, opts())).rejects.toMatchObject({ code: 'lane-closed', status: 422 });
    expect(await read('ready.tsv')).toBe(START);
    await rm(ready);
    await expect(steerQueue({ action: 'top', id: 'RQ-ONE' }, opts())).rejects.toBeInstanceOf(QueueSteerError);
  });
});

describe('phm queue', () => {
  const run = async (args: string[]) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdQueue(args);
    const out = { code, out: log.mock.calls.flat().join('\n'), err: err.mock.calls.flat().join('\n') };
    log.mockRestore(); err.mockRestore();
    return out;
  };
  beforeEach(() => { vi.stubEnv('ASHLR_RUNS_DIR', runs); vi.stubEnv('HOME', runs); });

  it('lists the queue, and --json carries it as the versioned launch field', async () => {
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.out.split('\n').slice(0, 2)).toEqual(['4 queued jobs, next to launch first. 1 parked.', expect.stringContaining('1  RQ-PHX-AREAC541')]);
    const json = JSON.parse((await run(['--json'])).out);
    expect(json.launch).toMatchObject({ schema: 'queue.order.v1', version: 1, count: 4 });
    expect(json.launch.jobs.map((job: { id: string }) => job.id)).toEqual(['RQ-PHX-AREAC541', 'RQ-ONE', 'RQ-PHX-AREAC544', 'RQ-TWO']);
  });
  it('runs each action, prints what changed and honours --dry-run', async () => {
    expect(await run(['--dry-run', 'top', 'RQ-TWO'])).toMatchObject({ code: 0, out: 'Would move RQ-TWO to the top (now 4 of 4).' });
    expect(await read('ready.tsv')).toBe(START);
    expect(JSON.parse((await run(['lane', 'RQ-ONE', 'devin', '--json'])).out)).toMatchObject({ schema: 'queue.action.v1', version: 1, changed: true, to: { lane: 'devin' } });
    expect(await run(['drop', 'RQ-ONE'])).toMatchObject({ code: 0, out: 'Dropped RQ-ONE (was 2 of 4). Its row is kept in queue/dropped.tsv.' });
    expect(await ids()).not.toContain('RQ-ONE');
    expect(await run(['top', 'RQ-NOPE'])).toMatchObject({ code: 1, err: 'That job is not in the queue.' });
    expect(JSON.parse((await run(['top', 'RQ-NOPE', '--json'])).out)).toEqual({ error: 'That job is not in the queue.', code: 'job-not-found' });
    for (const bad of [['top'], ['lane', 'RQ-ONE'], ['drop', 'RQ-ONE', 'extra'], ['top', 'RQ-ONE', '--force']]) expect((await run(bad)).code).toBe(2);
    expect((await run(['top', '--help'])).out).toContain('phm queue drop <id>');
  });
});

describe('GET and POST /api/verse/fleet/queue/order', () => {
  async function call(api: ReturnType<typeof createFleetRunsApi>, method: string, body?: unknown, allowDispatch = true, token = 'fixture-token') {
    const req = new PassThrough() as IncomingMessage & PassThrough;
    Object.assign(req, { method, url: PATH, headers: { 'content-type': 'application/json', 'x-ashlr-token': token, 'x-ashlr-channel': 'mobile' } });
    req.end(body === undefined ? undefined : JSON.stringify(body));
    let status = 0, payload = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { payload = chunk ?? ''; return this; } } as unknown as ServerResponse;
    await api({ token: 'fixture-token', allowDispatch } as VerseApiContext, req, res, PATH, method);
    return { status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
  }
  it('serves the list and applies an action through the same reader and writer', async () => {
    const queueSteer = vi.fn((request, options) => steerQueue(request, opts(options)));
    const api = createFleetRunsApi({ runsDir: runs, queueSteer });
    expect(await call(api, 'GET')).toMatchObject({ status: 200, body: { schema: 'queue.order.v1', version: 1, count: 4 } });
    expect(await call(api, 'POST', { action: 'top', id: 'RQ-TWO' })).toMatchObject({ status: 200, body: { schema: 'queue.action.v1', changed: true, to: { position: 1 } } });
    expect(queueSteer).toHaveBeenCalledWith({ action: 'top', id: 'RQ-TWO', dryRun: false }, { runsDir: runs, by: 'mobile' });
    expect((await ids())[0]).toBe('RQ-TWO');
  });
  it('gates writes, rejects malformed bodies and answers refusals in plain words', async () => {
    const queueSteer = vi.fn((request, options) => steerQueue(request, opts(options)));
    const api = createFleetRunsApi({ runsDir: runs, queueSteer });
    expect((await call(api, 'POST', { action: 'top', id: 'RQ-TWO' }, false)).status).toBe(404);
    expect((await call(api, 'POST', { action: 'top', id: 'RQ-TWO' }, true, 'wrong')).status).toBeGreaterThanOrEqual(400);
    for (const body of [null, { action: 'bump', id: 'RQ-TWO' }, { action: 'top', id: '../x' }, { action: 'top', id: 'RQ-TWO', lane: 'devin' }, { action: 'lane', id: 'RQ-TWO' }, { action: 'drop', id: 'RQ-TWO', force: true }]) {
      expect(await call(api, 'POST', body)).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID' } });
    }
    expect(queueSteer).not.toHaveBeenCalled();
    expect(await call(api, 'POST', { action: 'drop', id: 'RQ-NOPE' })).toEqual({ status: 404, body: { code: 'QUEUE_REFUSED', reason: 'job-not-found', error: 'That job is not in the queue.' } });
    expect(await read('ready.tsv')).toBe(START);
    expect((await call(api, 'PUT')).status).toBe(405);
  });
});
