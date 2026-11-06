import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusWorkPool } from '../src/cli/fleet-bus-work-pool.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.setConfig({ testTimeout: 30_000 });
let base: string, root: string, snapshot: string, prompt: string, events: string, script: string;
const post = (id: string) => expect(appendBusInbox({ id, from: 'leader', to: 'worker', priority: 'P1', ttl: 120_000,
  body: { kind: 'work', text: 'private request' } } satisfies BusEnvelope, { root }).status).toBe('posted');
const lines = () => existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean) : [];
const args = (max = 2, concurrency = 2, mode = 'barrier') => ['--to', 'worker', '--owner', 'pool', '--lease-ms', '60000',
  '--wait-ms', '500', '--max-jobs', String(max), '--concurrency', String(concurrency), '--snapshot', snapshot,
  '--prompt', prompt, '--root', root, '--', process.execPath, script, mode, events];
async function run(argv: string[]) {
  let out = '', err = '';
  const sink = (write: (text: string) => void) => new Writable({ write(chunk, _encoding, done) { write(String(chunk)); done(); } });
  const code = await cmdFleetBusWorkPool(argv, { stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
  return { code, out, err, result: out.startsWith('{') ? JSON.parse(out) : undefined };
}
function receipts() {
  const page = listBusInboxAfter(0, 100, { root });
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  return page.messages.filter(m => m.envelope.to === 'leader').map(m => m.envelope);
}
function claims() {
  return JSON.parse(readFileSync(join(root, 'bus-work-claims', 'claims.json'), 'utf8')) as
    Array<{ id: string; owner: string; completedAt: number | null }>;
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-pool-test-')); root = join(base, 'bus');
  snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); events = join(base, 'events'); script = join(base, 'worker.cjs');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'private prompt');
  mkdirSync(join(base, 'runs'), { mode: 0o700 });
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
  // The barrier fails within five seconds if two children do not overlap.
  writeFileSync(script, `const fs = require('node:fs');
    const [mode, file] = process.argv.slice(2); let input = '';
    process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
      const match = input.match(/BEGIN UNTRUSTED BUS REQUEST JSON[^\\n]*\\n([^\\n]+)/);
      if (!match) process.exit(9);
      const id = JSON.parse(match[1]).id;
      fs.appendFileSync(file, 'start:' + id + '\\n');
      console.log('private child output');
      const finish = () => { fs.appendFileSync(file, 'end:' + id + '\\n'); process.exit(mode === 'failure' && id === 'first' ? 7 : 0); };
      if (mode === 'barrier' || mode === 'failure') {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (fs.readFileSync(file, 'utf8').split('start:').length >= 3) {
            clearInterval(timer); setTimeout(finish, mode === 'failure' && id === 'second' ? 600 : 0);
          } else if (Date.now() >= deadline) { clearInterval(timer); process.exit(8); }
        }, 10);
      } else setTimeout(finish, 100);
    });`);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('overlaps independent requests, completes distinct claims and publishes correlated replies', async () => {
  post('first'); post('second');
  const result = await run(args());
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 2 } });
  expect(result.result.consumers.map((c: { quota: number }) => c.quota)).toEqual([1, 1]);
  expect(new Set(result.result.consumers.map((c: { owner: string }) => c.owner)).size).toBe(2);
  expect(lines().slice(0, 2).sort()).toEqual(['start:first', 'start:second']);
  expect(lines().filter(line => line.startsWith('start:')).sort()).toEqual(['start:first', 'start:second']);
  expect(claims().map(c => c.id).sort()).toEqual(['first', 'second']);
  expect(claims().every(c => typeof c.completedAt === 'number')).toBe(true);
  expect(new Set(claims().map(c => c.owner)).size).toBe(2);
  expect(receipts().map(r => (r.body as { inReplyTo: string }).inReplyTo).sort()).toEqual(['first', 'second']);
  expect(new Set(receipts().map(r => r.id)).size).toBe(2);
  expect(result.out + result.err).not.toMatch(/private|[a-f0-9]{64}/);
});

it('bounds total work and starts no more consumers than jobs', async () => {
  post('first'); post('second'); post('third');
  const result = await run(args(2, 4));
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 2 } });
  expect(result.result.consumers).toHaveLength(2);
  expect(lines().filter(line => line.startsWith('start:'))).toHaveLength(2);
  expect(claims()).toHaveLength(2);
});

it('runs sequentially at concurrency one and reports idle timeout separately', async () => {
  post('first'); post('second');
  const result = await run(args(2, 1, 'sequential'));
  expect(result).toMatchObject({ code: 0, result: { status: 'max-jobs', completed: 2 } });
  expect(lines()).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  const idle = await run(args(1, 1, 'sequential'));
  expect(idle).toMatchObject({ code: 0, result: { status: 'timeout', completed: 0, consumers: [{ status: 'timeout' }] } });
});

it('reports a failure only after the successful sibling has settled', async () => {
  post('first'); post('second');
  const result = await run(args(2, 2, 'failure'));
  expect(result).toMatchObject({ code: 1, result: { status: 'failed', completed: 1 } });
  expect(result.result.consumers.map((c: { status: string }) => c.status).sort()).toEqual(['failed', 'max-jobs']);
  expect(lines()).toContain('end:second');
  expect(claims()).toEqual([expect.objectContaining({ id: 'second', completedAt: expect.any(Number) })]);
  expect(receipts().map(r => (r.body as { inReplyTo: string }).inReplyTo).sort()).toEqual(['first', 'second']);
});

it('validates every flag before starting consumers and exposes the command entry', async () => {
  post('first');
  expect(resolveFleetSubcommand('bus-work-pool')).toEqual({ module: './fleet-bus-work-pool.js', exportName: 'cmdFleetBusWorkPool' });
  const help = await run(['--help']);
  expect(help.code).toBe(0); expect(help.out).toContain('total pool limit');
  const good = args();
  const swap = (key: string, value: string) => good.map((v, i) => i === good.indexOf(key) + 1 ? value : v);
  const bad = ['0', '5', '-1', '1.5', 'abc', '9007199254740992'].map(v => swap('--concurrency', v));
  bad.push(swap('--max-jobs', '0'), swap('--wait-ms', '0'), swap('--lease-ms', '0'), swap('--snapshot', 'relative'),
    swap('--root', 'relative'), swap('--owner', 'bad owner'), [...good.slice(0, good.indexOf('--')), '--owner', 'again', '--', process.execPath],
    good.slice(0, good.indexOf('--')), [...good.slice(0, good.indexOf('--')), '--']);
  for (const argv of bad) expect((await run(argv)).code).toBe(2);
  expect(lines()).toEqual([]);
  expect(existsSync(join(root, 'bus-work-claims', 'claims.json'))).toBe(false);
});
