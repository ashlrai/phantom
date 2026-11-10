import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';
import { HANDOFF_RECEIVE_BEGIN, receiveHandoffBus } from '../src/core/fleet/handoff-bus-receive.js';

let root: string, tmp: string, bus: string, snapshot: string, out: string, err: string;

const sink = (write: (s: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const flags = () => ['--id', 'msg-1', '--to', 'WORKER-9', '--snapshot', snapshot];
const recv = (extra: string[], argv: string[], options: BusInboxOptions = { root: bus }) =>
  cmdFleetHandoffReceive([...flags(), ...extra, '--', ...argv], options, io());
const post = () => appendBusInbox({ id: 'msg-1', from: 'planner', to: 'WORKER-9',
  priority: 'P3', ttl: 60_000,
  body: { kind: 'worker-handoff', taskId: 'TASK-1', prompt: 'Retained fixture prompt marker-10ssb1' } },
  { root: bus });
const spawned = () => join(root, 'child-ran');
const spawnArgv = () => [process.execPath, '-e',
  `require("fs").writeFileSync(${JSON.stringify(spawned())},"x")`];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tmpFiles = () => readdir(tmp);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-recv-deadline-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  tmp = join(root, 'tmp');
  bus = join(root, 'bus');
  snapshot = join(root, 'snapshot.json');
  out = '';
  err = '';
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'TASK-1', upstreamJobIds: [] },
    tasks: [{ jobId: 'TASK-1', text: 'snapshot retained context marker-10ssb1' }],
    outputs: [], byteBudget: 8192 }), { mode: 0o600 });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('fleet handoff-receive --timeout-ms', () => {
  it('terminates a hanging worker under an explicit short deadline, returning the timeout code promptly', async () => {
    expect(post().status).toBe('posted');
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    // Prints its pid, drains stdin, then idles on a timer: stays alive without a deadline.
    const hanging = 'process.stdin.resume();console.log(process.pid);setInterval(()=>{},1000)';
    const start = Date.now();
    expect(await recv(['--timeout-ms', '2000'], [process.execPath, '-e', hanging])).toBe(124);
    expect(Date.now() - start).toBeLessThan(15000);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(await tmpFiles()).toEqual([]);
  }, 20000);

  it.each(['0', '3600001', '-1', '1.5', 'NaN', '1e3', '9007199254740992', ' '])(
    'rejects invalid --timeout-ms %j before the inbox read or spawn', async value => {
      expect(post().status).toBe('posted');
      const now = vi.fn(() => Date.now());
      expect(await recv(['--timeout-ms', value], spawnArgv(), { root: bus, now })).toBe(2);
      expect(now).not.toHaveBeenCalled();
      expect(err).toContain('Usage:');
      expect(existsSync(spawned())).toBe(false);
      expect(await tmpFiles()).toEqual([]);
    });

  it('rejects a duplicate or valueless --timeout-ms before the inbox read or spawn', async () => {
    expect(post().status).toBe('posted');
    const now = vi.fn(() => Date.now());
    const opts: BusInboxOptions = { root: bus, now };
    expect(await recv(['--timeout-ms', '5000', '--timeout-ms', '5000'], spawnArgv(), opts)).toBe(2);
    expect(await recv(['--timeout-ms'], spawnArgv(), opts)).toBe(2);
    expect(now).not.toHaveBeenCalled();
    expect(err).toContain('Usage:');
    expect(existsSync(spawned())).toBe(false);
    expect(await tmpFiles()).toEqual([]);
  });

  it.each([0, -1, 3600001, 1.5, NaN, Infinity])(
    'rejects invalid API timeoutMs %s before the inbox read or spawn', async timeoutMs => {
      expect(post().status).toBe('posted');
      const now = vi.fn(() => Date.now());
      expect(await receiveHandoffBus({ id: 'msg-1', to: 'WORKER-9', snapshot, timeoutMs,
        argv: spawnArgv() }, { root: bus, now }, io())).toBe(2);
      expect(now).not.toHaveBeenCalled();
      expect(err).toContain('invalid input');
      expect(existsSync(spawned())).toBe(false);
      expect(await tmpFiles()).toEqual([]);
    });

  it('keeps an omitted deadline unbounded and leaves argv after -- literal', async () => {
    expect(post().status).toBe('posted');
    const capture = 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>' +
      'process.stdout.write(JSON.stringify({s,args:process.argv.slice(1)})))';
    expect(await recv([], [process.execPath, '-e', capture, 'a b', '$(echo fake)', '--timeout-ms'])).toBe(0);
    const result = JSON.parse(out) as { s: string; args: string[] };
    expect(result.args).toEqual(['a b', '$(echo fake)', '--timeout-ms']);
    expect(result.s.startsWith(HANDOFF_RECEIVE_BEGIN)).toBe(true);
    expect(result.s).toContain('Retained fixture prompt marker-10ssb1');
    expect(await tmpFiles()).toEqual([]);
  }, 30000);

  it('propagates a quick worker exit code when the deadline is not reached', async () => {
    expect(post().status).toBe('posted');
    expect(await recv(['--timeout-ms', '60000'], [process.execPath, '-e',
      'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))'])).toBe(7);
    expect(await tmpFiles()).toEqual([]);
  }, 30000);
});
