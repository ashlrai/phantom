import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextReply } from '../src/cli/fleet-context-reply.js';
import { publishContextReply, runContextReply, type ContextReplyIO } from '../src/core/fleet/context-result-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { LocalGateDeps } from '../src/core/fleet/local-gate.js';

let root: string, snapshot: string, prompt: string, requestFile: string, marker: string, busRoot: string;
let stdout: string, stderr: string;
const secretText = 'gate-private-diagnostic';
const sink = (write: (text: string) => void) => new Writable({ write(chunk, _encoding, done) { write(String(chunk)); done(); } });
const io = (gate?: LocalGateDeps): ContextReplyIO => ({
  stdout: sink(text => { stdout += text; }), stderr: sink(text => { stderr += text; }), gate,
});
const request = (ttl = 60000) => ({ id: 'request', from: 'requester', to: 'worker', priority: 'P1', ttl, body: { command: 'untrusted' } });
const options = (exit = 0) => ({ snapshot, prompt, requestFile, replyId: 'reply', argv: [process.execPath, '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(marker)},'spawn\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(${exit}))`] });
const args = (extra: string[] = [], exit = 0) => ['--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile,
  '--reply-id', 'reply', ...extra, '--', ...options(exit).argv];
const page = () => listBusInboxAfter(0, 50, { root: busRoot });
const gate = (fail = false) => {
  let calls = 0, gates = 0;
  const deps: LocalGateDeps = {
    exec: async (command, args) => {
      calls++;
      return { ok: !(fail && args.includes('--noEmit')), stdout: command === 'git' ? 'a'.repeat(40) : secretText, stderr: secretText };
    },
    appendMetric: async () => { gates++; throw new Error(secretText); },
    warn: () => { throw new Error('gate warning escaped'); },
  };
  return { deps, counts: () => ({ calls, gates }) };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checked-reply-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); requestFile = join(root, 'request.json');
  marker = join(root, 'spawn.txt'); busRoot = join(root, 'bus'); stdout = ''; stderr = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  await writeFile(prompt, 'prompt'); await writeFile(requestFile, JSON.stringify(request()));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each([false, true])('CLI waits for the real gate and publishes its fixed verdict (fail=%s)', async fail => {
  const g = gate(fail);
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const exec = g.deps.exec!;
  g.deps.exec = async (...params) => { if (params[1].includes('--noEmit')) { reached(); await blocked; } return exec(...params); };
  const running = cmdFleetContextReply(args(['--check', '--budget-seconds', '10']), io(g.deps), { root: busRoot });
  await entered;
  expect(page()).toMatchObject({ status: 'ok', messages: [] });
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
  release();
  expect(await running).toBe(fail ? 1 : 0);
  expect(g.counts()).toEqual({ calls: 4, gates: 1 });
  const result = page();
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('missing bus');
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]!.envelope).toMatchObject({ from: 'worker', to: 'requester', body: {
    inReplyTo: 'request', kind: 'worker-exit', exitCode: 0, succeeded: !fail, verification: fail ? 'fail' : 'pass',
  } });
  expect(JSON.stringify(result)).not.toContain(secretText);
  expect(stdout + stderr).not.toContain(secretText);
  expect(stderr).toContain(`"verification":"${fail ? 'fail' : 'pass'}"`);
}, 30000);

it('reports a thrown gate as an error and retains the process result', async () => {
  const g = gate();
  g.deps.now = () => { throw new Error(secretText); };
  const result = await runContextReply({ ...options(), check: {} }, io(g.deps), { root: busRoot });
  expect(result).toMatchObject({ workerExit: { status: 'returned', exitCode: 0 }, verification: 'error', exitCode: 1,
    reply: { body: { inReplyTo: 'request', exitCode: 0, succeeded: false, verification: 'error' } } });
  expect(JSON.stringify(result) + stdout + stderr).not.toContain(secretText);
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
}, 30000);

it('skips the gate on worker failure', async () => {
  const g = gate();
  expect(await cmdFleetContextReply(args(['--check'], 7), io(g.deps), { root: busRoot })).toBe(7);
  expect(g.counts()).toEqual({ calls: 0, gates: 0 });
  expect(page()).toMatchObject({ messages: [{ envelope: { body: { exitCode: 7, succeeded: false, verification: 'skipped' } } }] });
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
}, 30000);

it.each([['--budget-seconds', '1'], ['--check', '--budget-seconds', '0'], ['--check', '--budget-seconds', 'Infinity'],
  ['--check', '--budget-seconds', 'NaN'], ['--check', '--budget-seconds', '-1'], ['--check', '--check'],
  ['--check', '--budget-seconds'], ['--check', '--budget-seconds', '1', '--budget-seconds', '2']])('rejects invalid flags %j before effects', async extra => {
  const g = gate();
  expect(await cmdFleetContextReply(args(extra), io(g.deps), { root: busRoot })).toBe(2);
  expect(g.counts()).toEqual({ calls: 0, gates: 0 });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(page()).toMatchObject({ messages: [] });
});

it.each([0, -1, Infinity, NaN])('rejects invalid runner budget %s before launch', async budgetSeconds => {
  const g = gate();
  const result = await runContextReply({ ...options(), check: { budgetSeconds } }, io(g.deps), { root: busRoot });
  expect(result).toMatchObject({ workerExit: { status: 'not-started' }, exitCode: 2, replyReceipt: { status: 'not-attempted' } });
  expect(g.counts()).toEqual({ calls: 0, gates: 0 });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('publishes nothing if the request expires while the gate runs', async () => {
  await writeFile(requestFile, JSON.stringify(request(10000)));
  const g = gate(), exec = g.deps.exec!;
  const start = performance.now();
  let enteredAt = 0;
  g.deps.exec = async (...params) => { if (params[1].includes('--noEmit')) { enteredAt = performance.now(); await new Promise(resolve => setTimeout(resolve, 10100)); } return exec(...params); };
  const result = await runContextReply({ ...options(), check: {} }, io(g.deps), { root: busRoot });
  expect(enteredAt - start).toBeLessThan(10000);
  expect(result).toMatchObject({ workerExit: { status: 'returned', exitCode: 0 }, verification: 'pass', exitCode: 1,
    replyReceipt: { status: 'expired' }, reply: null });
  expect(g.counts()).toEqual({ calls: 4, gates: 1 });
  expect(page()).toMatchObject({ messages: [] });
}, 30000);

it('retains the checked envelope for retries without rerunning either step', async () => {
  await writeFile(busRoot, 'unavailable');
  const g = gate(true);
  const result = await runContextReply({ ...options(), check: {} }, io(g.deps), { root: busRoot });
  expect(result).toMatchObject({ verification: 'fail', exitCode: 1, replyReceipt: { status: 'unavailable' } });
  const retryRoot = join(root, 'retry');
  expect(publishContextReply(result.reply!, 1, { root: retryRoot }).status).toBe('posted');
  expect(publishContextReply(result.reply!, 2, { root: retryRoot }).status).toBe('duplicate');
  expect(g.counts()).toEqual({ calls: 4, gates: 1 });
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
}, 30000);

it('keeps unchecked wire and receipt shape unchanged and explains opt-in help', async () => {
  const g = gate();
  expect(await cmdFleetContextReply(args(), io(g.deps), { root: busRoot })).toBe(0);
  expect(g.counts()).toEqual({ calls: 0, gates: 0 });
  const result = page();
  if (result.status !== 'ok') throw new Error('missing bus');
  expect(result.messages[0]!.envelope.body).toEqual({ inReplyTo: 'request', kind: 'worker-exit', exitCode: 0, succeeded: true });
  expect(stderr).not.toContain('verification');
  expect(await cmdFleetContextReply(['--help'], io(), { root: busRoot })).toBe(0);
  expect(stdout).toContain('--check opts in'); expect(stdout).toContain('Without --check');
}, 30000);
