import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReply } from '../src/cli/fleet-handoff-reply.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';
import { CONTEXT_END, CONTEXT_START } from '../src/core/fleet/context-worker-run.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END } from '../src/core/fleet/handoff-bus-receive.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { deliverSpooledContextReply } from '../src/core/fleet/context-reply-spool.js';

let root: string, tmp: string, busRoot: string, spoolDir: string, snapshot: string, out: string, err: string;

const TASK = 'WORK-REPLY-1';
const pwned = () => join(root, 'check-executed');
const spawned = () => join(root, 'child-ran');
const marker = () => join(root, 'spawn.txt');
const request = (ttl = 60000) => ({
  id: 'msg-1', from: 'planner', to: 'WORKER-9', priority: 'P3' as const, ttl,
  // Clearly fake, executable-looking fixture text: prompt data only, never a command.
  body: { kind: 'worker-handoff', taskId: TASK, prompt: `fixture prompt marker-6q $(touch ${pwned()})` },
});
const pack = (jobId = TASK) => ({
  node: { jobId, upstreamJobIds: [] },
  tasks: [{ jobId, text: 'snapshot retained context marker-31b' }],
  outputs: [],
  byteBudget: 8192,
});
const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const bus = (options: BusInboxOptions = {}): BusInboxOptions => ({ root: busRoot, ...options });
const args = (extra: string[], timeout = '30000') => ['--id', 'msg-1', '--to', 'WORKER-9',
  '--snapshot', snapshot, '--reply-id', 'msg-1-exit', '--spool-dir', spoolDir,
  '--timeout-ms', timeout, ...extra];
const reply = (extra: string[], options: BusInboxOptions = {}) =>
  cmdFleetHandoffReply(args(extra), bus(options), io());
const post = (ttl?: number, options: BusInboxOptions = {}) => appendBusInbox(request(ttl), bus(options));
const tmpFiles = () => readdir(tmp);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-reply-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  tmp = join(root, 'tmp');
  busRoot = join(root, 'bus');
  spoolDir = join(root, 'spool');
  snapshot = join(root, 'snapshot.json');
  out = '';
  err = '';
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
  await writeFile(snapshot, JSON.stringify(pack()), { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('fleet handoff-reply', () => {
  it('delivers the handoff as untrusted stdin context and posts a correlated worker-exit reply', async () => {
    expect(post().status).toBe('posted');
    const capture = 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>' +
      'process.stdout.write(JSON.stringify({s,args:process.argv.slice(1)})))';
    const [code, round] = await Promise.all([
      reply(['--', process.execPath, '-e', capture, 'a b', '$(echo fake)']),
      requestBusRoundtrip(request(), 20000, 100, bus()),
    ]);
    expect(code).toBe(0);
    expect(round.outcome).toBe('replied');
    const replyEnv = round.reply!.envelope;
    expect([replyEnv.id, replyEnv.from, replyEnv.to]).toEqual(['msg-1-exit', 'WORKER-9', 'planner']);
    expect(replyEnv.body).toMatchObject({ inReplyTo: 'msg-1', kind: 'worker-exit', exitCode: 0, succeeded: true });
    const seen = JSON.parse(out) as { s: string; args: string[] };
    expect(seen.args).toEqual(['a b', '$(echo fake)']);
    expect(seen.s.startsWith(HANDOFF_RECEIVE_BEGIN)).toBe(true);
    expect(seen.s).toContain('fixture prompt marker-6q');
    expect(seen.s).toContain('BEGIN UNTRUSTED BUS REQUEST JSON');
    expect(seen.s).toContain('"kind":"worker-handoff"');
    expect(seen.s).toContain(HANDOFF_RECEIVE_END);
    expect(seen.s).toContain(CONTEXT_START);
    expect(seen.s.endsWith(CONTEXT_END)).toBe(true);
    expect(existsSync(pwned())).toBe(false);
    expect(err).not.toContain('marker-6q');
    expect(err).toContain('"workerExit":{"status":"returned","exitCode":0}');
    expect(err).toContain('"delivery":{"status":"posted"}');
    expect(await tmpFiles()).toEqual([]);
  }, 30000);

  it('reports a failing worker as a non-success worker-exit reply', async () => {
    expect(post().status).toBe('posted');
    const [code, round] = await Promise.all([
      reply(['--', process.execPath, '-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))']),
      requestBusRoundtrip(request(), 20000, 100, bus()),
    ]);
    expect(code).toBe(7);
    expect(round.outcome).toBe('replied');
    expect(round.reply!.envelope.body).toMatchObject({ kind: 'worker-exit', exitCode: 7, succeeded: false });
    expect(err).toContain('"workerExit":{"status":"returned","exitCode":7}');
  }, 30000);

  it('bounds the worker by --timeout-ms and still publishes the exit reply', async () => {
    expect(post().status).toBe('posted');
    const code = await cmdFleetHandoffReply(
      args(['--', process.execPath, '-e',
        'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{},30000))'], '400'),
      bus(), io());
    expect(code).toBe(124);
    expect(err).toContain('"workerExit":{"status":"returned","exitCode":124}');
    expect(err).toContain('"delivery":{"status":"posted"}');
    const page = listBusInboxAfter(0, 50, bus());
    expect(page.status === 'ok' && page.messages.some(m =>
      m.envelope.id === 'msg-1-exit' && (m.envelope.body as Record<string, unknown>).exitCode === 124)).toBe(true);
    expect(await tmpFiles()).toEqual([]);
  }, 30000);

  it('refuses wrong recipient, snapshot mismatch, distinct-id violation, expired and missing requests before spawn', async () => {
    const spawn = ['--', process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(spawned())},"x")`];
    expect(await reply(spawn)).toBe(1);
    expect(err).toContain('no live handoff');
    expect(post().status).toBe('posted');
    err = '';
    const wrongTo = args(spawn).map(a => (a === 'WORKER-9' ? 'SNOOPER-1' : a));
    expect(await cmdFleetHandoffReply(wrongTo, bus(), io())).toBe(1);
    expect(err).toContain('not addressed');
    err = '';
    const sameId = args(spawn).map(a => (a === 'msg-1-exit' ? 'msg-1' : a));
    expect(await cmdFleetHandoffReply(sameId, bus(), io())).toBe(1);
    expect(err).toContain('differ');
    err = '';
    await writeFile(snapshot, JSON.stringify(pack('OTHER-JOB-9')), { mode: 0o600 });
    expect(await reply(spawn)).toBe(1);
    expect(err).toContain('does not match');
    await writeFile(snapshot, JSON.stringify(pack()), { mode: 0o600 });
    // An expired second envelope is refused the same way, without a child.
    err = '';
    const expired = { ...request(60000), id: 'msg-2' };
    expect(appendBusInbox(expired, bus({ now: () => 1000 })).status).toBe('posted');
    const stale = args(spawn).map(a => (a === 'msg-1' ? 'msg-2' : a));
    expect(await cmdFleetHandoffReply(stale, bus({ now: () => 1000 + 60001 }), io())).toBe(1);
    expect(err).toContain('no live handoff');
    await rm(snapshot);
    expect(await reply(spawn)).toBe(1);
    expect(existsSync(spawned())).toBe(false);
    expect(await tmpFiles()).toEqual([]);
  }, 30000);

  it('rejects malformed flags and non-token or non-absolute values before touching the bus', async () => {
    const tail = ['--', process.execPath, '-e', '0'];
    const base = ['--id', 'msg-1', '--to', 'WORKER-9', '--snapshot', snapshot,
      '--reply-id', 'r1', '--spool-dir', spoolDir, '--timeout-ms', '30000'];
    for (const a of [
      [...base],
      [...base, '--'],
      [...base.slice(0, 2), ...tail],
      [...base.slice(0, 10), ...tail],
      [...base.slice(0, -2), '--timeout-ms', 'abc', ...tail],
      [...base.slice(0, -2), '--timeout-ms', '0', ...tail],
      [...base.slice(0, -2), '--timeout-ms', '3600001', ...tail],
      ['--id', 'bad id', ...base.slice(2), ...tail],
      ['--id', 'msg-1', '--to', 'bad addr', ...base.slice(4), ...tail],
      [...base.slice(0, 4), '--snapshot', 'rel/snap.json', ...base.slice(6), ...tail],
      [...base.slice(0, 8), '--spool-dir', 'rel/spool', ...base.slice(10), ...tail],
      [...base, '--bogus', 'x', ...tail],
      [...base, '--id', 'dup', ...tail],
      [...base, ...tail.slice(1)],
    ]) {
      expect(await cmdFleetHandoffReply(a, bus(), io())).toBe(2);
    }
    expect(existsSync(busRoot)).toBe(false);
    expect(await tmpFiles()).toEqual([]);
  }, 30000);

  it('spools a failed publication and retries it without rerunning the worker', async () => {
    expect(post().status).toBe('posted');
    const spawn = ['--', process.execPath, '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker())},'spawn\\n');` +
      'process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.exit(0))'];
    const lock = acquireLocalStoreLock(join(busRoot, 'bus-inbox', 'writer.lock'), 0,
      { anchorPath: busRoot, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    let code: number;
    try {
      code = await reply(spawn);
    } finally {
      releaseLocalStoreLock(lock);
    }
    expect(code).toBe(1);
    expect(err).toContain('"workerExit":{"status":"returned","exitCode":0}');
    expect(err).toContain('"delivery":{"status":"pending"}');
    expect(await readFile(marker(), 'utf8')).toBe('spawn\n');
    const names = (await readdir(spoolDir)).filter(n => /^reply-[0-9a-f]{32}\.json$/.test(n));
    expect(names).toHaveLength(1);
    const retry = deliverSpooledContextReply(join(spoolDir, names[0]!), bus());
    expect(retry.exitCode).toBe(0);
    expect(retry.delivery.status).toBe('posted');
    expect(retry.workerExit).toEqual({ status: 'returned', exitCode: 0 });
    expect(await readFile(marker(), 'utf8')).toBe('spawn\n');
    const page = listBusInboxAfter(0, 50, bus());
    const replies = page.status === 'ok' ? page.messages.filter(m => m.envelope.id === 'msg-1-exit') : [];
    expect(replies).toHaveLength(1);
    expect(replies[0]!.envelope.body).toMatchObject({ inReplyTo: 'msg-1', kind: 'worker-exit', exitCode: 0 });
    expect(await tmpFiles()).toEqual([]);
  }, 30000);

  it('dispatches through the generated fleet convention registry and owns its --help', async () => {
    const loader = FLEET_SUBCOMMAND_LOADERS['handoff-reply'];
    expect(loader).toBeTypeOf('function');
    expect(typeof (await loader!()).cmdFleetHandoffReply).toBe('function');
    expect(await cmdFleetHandoffReply(['--help'], bus(), io())).toBe(0);
    expect(out).toContain('fleet handoff-reply');
    expect(out).toContain('Example:');
    expect(existsSync(busRoot)).toBe(false);
    expect(await tmpFiles()).toEqual([]);
  });
});
