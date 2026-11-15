import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const JOB = 'WORK-CLEAN-116';
const MSG = 'msg-clean-116';
const FROM = 'planner';
const TO = 'worker-116';
const FIXED_NOW = 1_800_000_000_000;

let root = '';
let tmp = '';
let busRoot = '';
let file = '';
let snapshot = '';
let out = '';
let err = '';
let inflight: Promise<number> | undefined;

// The receive runner materializes prompt.txt + snapshot.json under
// mkdtemp(join(tmpdir(), 'phm-handoff-recv-')) and removes the directory in
// finally; the child inherits TMPDIR, so scanning os.tmpdir() for that prefix
// is the only path information the stdin-only runner contract exposes. Every
// child records what it finds before doing anything else.
const RECORD_WORKSPACE = `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmpdir=os.tmpdir();
const dirs=fs.readdirSync(tmpdir).filter(function(d){return d.indexOf('phm-handoff-recv-')===0}).map(function(d){return path.join(tmpdir,d)});
const rec={pid:process.pid,dirs:dirs.map(function(d){
const e={dir:d,prompt:path.join(d,'prompt.txt'),snapshot:path.join(d,'snapshot.json')};
try{e.promptBytes=fs.statSync(e.prompt).size;e.promptHead=fs.readFileSync(e.prompt,'utf8').slice(0,120)}catch(err){e.promptError=String(err&&err.code||err)}
try{e.snapshotBytes=fs.statSync(e.snapshot).size;const j=JSON.parse(fs.readFileSync(e.snapshot,'utf8'));e.snapshotJobId=j&&j.node&&j.node.jobId}catch(err){e.snapshotError=String(err&&err.code||err)}
return e})};
fs.writeFileSync(process.argv[1],JSON.stringify(rec));
let s='';
function recordStdin(){
rec.stdinBytes=s.length;
rec.stdinHasHandoff=s.indexOf('BEGIN UNTRUSTED RETAINED BUS HANDOFF')>=0;
rec.stdinHasContext=s.indexOf('BEGIN UNTRUSTED CITED CONTEXT JSONL')>=0;
fs.writeFileSync(process.argv[1],JSON.stringify(rec));
}
process.stdin.on('data',function(c){s+=c});
process.stdin.on('end',recordStdin);
`;

const EXIT_NONZERO = `process.stdin.on('end',function(){process.exit(7)});`;
const STAY_ALIVE = `setInterval(function(){},1000);`;
const RETRY_OK = `process.stdin.on('end',function(){process.stdout.write('retry-ok',function(){process.exit(0)})});`;

interface RecordedInput {
  dir: string;
  prompt: string;
  snapshot: string;
  promptBytes?: number;
  promptHead?: string;
  promptError?: string;
  snapshotBytes?: number;
  snapshotJobId?: unknown;
  snapshotError?: string;
}
interface ChildRecord {
  pid: number;
  dirs: RecordedInput[];
  stdinBytes?: number;
  stdinHasHandoff?: boolean;
  stdinHasContext?: boolean;
}

const handoff = () => ({
  id: JOB,
  task: 'Synthetic exit-cleanup fixture task marker-116',
  files: [{ path: 'src/example.ts' }],
  constraints: [],
  check: 'Check synthetic cleanup result',
});
// Synthetic NodeContextPackInput whose node.jobId matches the handoff taskId.
const pack = () => ({
  node: { jobId: JOB, upstreamJobIds: [] },
  tasks: [{ jobId: JOB, text: 'snapshot retained context marker-116' }],
  outputs: [],
  byteBudget: 8192,
});
const sink = (write: (text: string) => void) =>
  new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const busOptions = () => ({ root: busRoot, now: () => FIXED_NOW });
const post = () => cmdFleetHandoffSend(
  ['--file', file, '--id', MSG, '--from', FROM, '--to', TO, '--apply', '--json'], busOptions());
const receipt = () => listBusInboxAfter(0, 50, busOptions());
const flags = () => ['--id', MSG, '--to', TO, '--snapshot', snapshot];
const receive = (extra: string[], argv: string[]) => {
  const pending = cmdFleetHandoffReceive([...flags(), ...extra, '--', ...argv], busOptions(), io());
  inflight = pending;
  return pending;
};
const childArgv = (tail: string, marker: string): string[] =>
  [process.execPath, '-e', RECORD_WORKSPACE + tail, '--', marker];
const readRecord = (path: string): ChildRecord =>
  JSON.parse(readFileSync(path, 'utf8')) as ChildRecord;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const recvDirs = () => readdirSync(tmp).filter(name => name.startsWith('phm-handoff-recv-'));

const expectMaterialized = (rec: ChildRecord): RecordedInput => {
  expect(rec.pid).toBeGreaterThan(0);
  expect(rec.dirs).toHaveLength(1);
  const ws = rec.dirs[0]!;
  expect(ws.dir.startsWith(join(tmp, 'phm-handoff-recv-'))).toBe(true);
  expect(ws.prompt.endsWith('prompt.txt')).toBe(true);
  expect(ws.snapshot.endsWith('snapshot.json')).toBe(true);
  expect(ws.promptError).toBeUndefined();
  expect(ws.snapshotError).toBeUndefined();
  expect(ws.promptBytes ?? 0).toBeGreaterThan(0);
  expect(ws.snapshotBytes ?? 0).toBeGreaterThan(0);
  expect(ws.snapshotJobId).toBe(JOB);
  expect(ws.promptHead ?? '').toContain('BEGIN UNTRUSTED RETAINED BUS HANDOFF');
  return ws;
};
const expectReleased = (ws: RecordedInput): void => {
  expect(existsSync(ws.dir)).toBe(false);
  expect(existsSync(ws.prompt)).toBe(false);
  expect(existsSync(ws.snapshot)).toBe(false);
  expect(recvDirs()).toEqual([]);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-exit-cleanup-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  vi.stubEnv('ASHLR_HOME', join(root, '.ashlr'));
  vi.stubEnv('TMPDIR', join(root, 'tmp'));
  tmp = join(root, 'tmp');
  busRoot = join(root, 'bus');
  file = join(root, 'handoff.json');
  snapshot = join(root, 'snapshot.json');
  out = '';
  err = '';
  inflight = undefined;
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
  await writeFile(file, JSON.stringify(handoff()), { mode: 0o600 });
  await writeFile(snapshot, JSON.stringify(pack()), { mode: 0o600 });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  // Kill any child that outlived its receive before deleting the fixture; only
  // pids the children themselves recorded inside this test's root are touched.
  if (root) {
    try {
      for (const name of readdirSync(root)) {
        if (!name.startsWith('record-') || !name.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(readFileSync(join(root, name), 'utf8')) as { pid?: number };
          if (typeof rec.pid === 'number' && rec.pid > 0) {
            try { process.kill(rec.pid, 'SIGKILL'); } catch { /* already exited */ }
          }
        } catch { /* unreadable marker */ }
      }
    } catch { /* root already removed */ }
  }
  if (inflight) {
    const pending = inflight;
    inflight = undefined;
    await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('fleet handoff-receive worker exit cleanup', () => {
  it('releases the materialized context when the worker exits nonzero, then accepts a retry', async () => {
    expect(await post()).toBe(0);
    const receipts = receipt();
    expect(receipts.status).toBe('ok');
    const snapshotText = readFileSync(snapshot, 'utf8');

    const marker = join(root, 'record-exit.json');
    expect(await receive([], childArgv(EXIT_NONZERO, marker))).toBe(7);

    const rec = readRecord(marker);
    expect(rec.stdinHasHandoff).toBe(true);
    expect(rec.stdinHasContext).toBe(true);
    expect(alive(rec.pid)).toBe(false);
    expectReleased(expectMaterialized(rec));
    expect(readFileSync(snapshot, 'utf8')).toBe(snapshotText);
    expect(receipt()).toEqual(receipts);
    expect(err).not.toContain('Synthetic exit-cleanup fixture task');

    out = '';
    err = '';
    const retryMarker = join(root, 'record-retry.json');
    expect(await receive([], childArgv(RETRY_OK, retryMarker))).toBe(0);
    expect(out).toContain('retry-ok');
    expect(err).toBe('');
    const retry = readRecord(retryMarker);
    expect(retry.stdinHasHandoff).toBe(true);
    expect(alive(retry.pid)).toBe(false);
    expectReleased(expectMaterialized(retry));
    expect(readFileSync(snapshot, 'utf8')).toBe(snapshotText);
    expect(receipt()).toEqual(receipts);
  }, 30000);

  it('releases the materialized context when the worker is killed at its deadline, then accepts a retry', async () => {
    expect(await post()).toBe(0);
    const receipts = receipt();
    expect(receipts.status).toBe('ok');
    const snapshotText = readFileSync(snapshot, 'utf8');

    const marker = join(root, 'record-timeout.json');
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    try {
      const pending = receive(['--timeout-ms', '2000'], childArgv(STAY_ALIVE, marker));
      const code = await Promise.race([pending, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('receive did not settle within watchdog')), 20000);
      })]);
      expect(code).toBe(124);
      expect(Date.now() - start).toBeLessThan(20000);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }

    const rec = readRecord(marker);
    expect(rec.stdinHasHandoff).toBe(true);
    expect(rec.stdinHasContext).toBe(true);
    expect(alive(rec.pid)).toBe(false);
    expect(err).toContain('worker ended by SIGTERM');
    expectReleased(expectMaterialized(rec));
    expect(readFileSync(snapshot, 'utf8')).toBe(snapshotText);
    expect(receipt()).toEqual(receipts);

    out = '';
    err = '';
    const retryMarker = join(root, 'record-retry.json');
    expect(await receive([], childArgv(RETRY_OK, retryMarker))).toBe(0);
    expect(out).toContain('retry-ok');
    expect(err).toBe('');
    const retry = readRecord(retryMarker);
    expect(alive(retry.pid)).toBe(false);
    expectReleased(expectMaterialized(retry));
    expect(readFileSync(snapshot, 'utf8')).toBe(snapshotText);
    expect(receipt()).toEqual(receipts);
  }, 30000);
});
