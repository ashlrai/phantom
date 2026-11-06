import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextReply } from '../src/cli/fleet-context-reply.js';
import { publishContextReply, runContextReply } from '../src/core/fleet/context-result-bus.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

let root: string, snapshot: string, prompt: string, requestFile: string, marker: string, busRoot: string;
let out: string, err: string;
const request = (ttl = 60000): BusEnvelope => ({ id: 'request', from: 'requester', to: 'worker', priority: 'P1', ttl, body: { command: 'never execute this' } });
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const options = (exit = 0, delay = 0) => ({ snapshot, prompt, requestFile, replyId: 'reply', argv: [process.execPath, '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(marker)},'spawn\\n');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(s);console.error('private child stderr');setTimeout(()=>process.exit(${exit}),${delay})})`] });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-reply-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); requestFile = join(root, 'request.json');
  marker = join(root, 'spawn.txt'); busRoot = join(root, 'bus'); out = ''; err = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: ['UPSTREAM'] }, tasks: [], outputs: [], byteBudget: 2000 }));
  await writeFile(join(root, '.ashlr-runs', 'UPSTREAM.notes.md'), 'private live context');
  await writeFile(prompt, 'private prompt'); await writeFile(requestFile, JSON.stringify(request()));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each([0, 7])('real worker exit %s wakes its requester and preserves the process result', async exit => {
  const waiting = requestBusRoundtrip(request(), 10000, 100, { root: busRoot });
  const opts = options(exit);
  const args = ['--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile, '--reply-id', 'reply', '--', ...opts.argv];
  expect(await cmdFleetContextReply(args, io(), { root: busRoot })).toBe(exit);
  const roundtrip = await waiting;
  expect(roundtrip.outcome).toBe('replied');
  expect(roundtrip.reply?.envelope).toMatchObject({ from: 'worker', to: 'requester', priority: 'P1', body: {
    inReplyTo: 'request', kind: 'worker-exit', exitCode: exit, succeeded: exit === 0,
  } });
  expect(roundtrip.reply!.envelope.ttl).toBeLessThan(request().ttl);
  expect(out).toContain('private prompt'); expect(out).toContain('private live context');
  expect(err).toContain('private child stderr');
  expect(err).toContain(`"workerExit":{"status":"returned","exitCode":${exit}}`);
  expect(err).toContain('"replyReceipt":{"status":"posted"}');
  const stored = JSON.parse(await readFile(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8'));
  const reply = stored.rows.find((r: { envelope: BusEnvelope }) => r.envelope.id === 'reply').envelope;
  expect(Object.keys(reply.body).sort()).toEqual(['exitCode', 'inReplyTo', 'kind', 'succeeded']);
  expect(JSON.stringify(reply)).not.toMatch(/private|command|CONTEXT/);
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
}, 20000);

it.each(['invalid', 'oversized', 'symlink', 'reply-id'])('refuses %s request input before any spawn', async kind => {
  const opts = options();
  if (kind === 'invalid') await writeFile(requestFile, '{}');
  if (kind === 'oversized') await writeFile(requestFile, ' '.repeat(65537));
  if (kind === 'symlink') { const link = join(root, 'link'); await symlink(requestFile, link); opts.requestFile = link; }
  if (kind === 'reply-id') opts.replyId = 'invalid\n';
  const result = await runContextReply(opts, io(), { root: busRoot });
  expect(result.workerExit.status).toBe('not-started'); expect(result.exitCode).toBe(2);
  expect(result.replyReceipt.status).toBe('not-attempted');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(listBusInboxAfter(0, 50, { root: busRoot })).toMatchObject({ messages: [] });
});

it('refuses publication when the original TTL expires during the worker', async () => {
  await writeFile(requestFile, JSON.stringify(request(100)));
  const result = await runContextReply(options(0, 150), io(), { root: busRoot });
  expect(result.workerExit).toEqual({ status: 'returned', exitCode: 0 });
  expect(result.replyReceipt.status).toBe('expired'); expect(result.exitCode).toBe(1);
  expect(listBusInboxAfter(0, 50, { root: busRoot })).toMatchObject({ messages: [] });
}, 20000);

it.each([0, 7])('post refusal preserves exit %s and retries publication without another spawn', async exit => {
  await writeFile(busRoot, 'refuse directory');
  const result = await runContextReply(options(exit), io(), { root: busRoot });
  expect(result.workerExit).toEqual({ status: 'returned', exitCode: exit });
  expect(result.replyReceipt.status).toBe('unavailable'); expect(result.exitCode).toBe(exit || 1);
  const retryRoot = join(root, 'recovered-bus');
  expect(publishContextReply(result.reply!, 10, { root: retryRoot }).status).toBe('posted');
  expect(publishContextReply(result.reply!, 20, { root: retryRoot }).status).toBe('duplicate');
  expect(publishContextReply(result.reply!, result.reply!.ttl, { root: retryRoot }).status).toBe('expired');
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
  const page = listBusInboxAfter(0, 50, { root: retryRoot });
  expect(page.status === 'ok' && page.messages.length).toBe(1);
}, 20000);

it('rejects implicit launches and keeps invalid CLI diagnostics static', async () => {
  expect(await cmdFleetContextReply(['--secret-argument'], io(), { root: busRoot })).toBe(2);
  expect(err).not.toContain('--secret-argument');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
