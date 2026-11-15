import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Live receipts need the real clock: claims compare TTL against Date.now().
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fake-bus-protocol-'));
  chmodSync(root, 0o700);
  roots.push(root);
  const options = { root };
  let count = 0;
  const post = async (envelope: unknown) => {
    const file = join(root, `fake-envelope-${count++}.json`);
    writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
    const { code, out } = await run(['post', '--file', file]);
    return { code, receipt: out[0] as { status: string } };
  };
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
    try {
      const code = await cmdCommsBus(args, options);
      return { code, out: lines.map(line => JSON.parse(line) as Record<string, unknown>) };
    } finally { spy.mockRestore(); }
  };
  return { root, post, run };
}

const task = (id: string, to: string, extra: Record<string, unknown> = {}) => ({
  id, from: 'fake-planner', to, priority: 'P1', ttl: 60000,
  body: { protocol: { version: 1, kind: 'task', topic: to }, text: 'fake work', ...extra },
});

it('filters reads by protocol kind and topic namespace without changing legacy filters', async () => {
  const f = fixture();
  expect((await f.post(task('fake-t1', 'fleet.deploy'))).receipt.status).toBe('posted');
  expect((await f.post({ id: 'fake-s1', from: 'fake-a', to: 'codex', priority: 'P3', ttl: 60000,
    body: { protocol: { version: 1, kind: 'status' } } })).receipt.status).toBe('posted');
  expect((await f.post({ id: 'fake-r1', from: 'fake-a', to: 'human.mason', priority: 'P2', ttl: 60000,
    body: { protocol: { version: 1, kind: 'result', topic: 'human.mason', payload_ref: 'artifact:fake/run-1' } } })).receipt.status).toBe('posted');
  const ids = async (args: string[]) => {
    const { code, out } = await f.run(['read', '--after', '0', ...args]);
    expect(code).toBe(0);
    return (out[0]!.messages as Array<{ envelope: { id: string } }>).map(row => row.envelope.id);
  };
  expect(await ids([])).toEqual(['fake-t1', 'fake-s1', 'fake-r1']);
  expect(await ids(['--kind', 'task'])).toEqual(['fake-t1']);
  expect(await ids(['--kind', 'result'])).toEqual(['fake-r1']);
  expect(await ids(['--topic', 'fleet.*'])).toEqual(['fake-t1']);
  expect(await ids(['--topic', 'fleet.deploy'])).toEqual(['fake-t1']);
  expect(await ids(['--topic', 'human.*'])).toEqual(['fake-r1']);
  expect(await ids(['--topic', 'repo.*'])).toEqual([]);
  expect(await ids(['--topic', 'fleet.deploy', '--kind', 'result'])).toEqual([]);
  expect(await ids(['--to', 'codex', '--kind', 'status'])).toEqual(['fake-s1']);
});

it('refuses malformed protocol before any append and rejects unknown filter values with exit 2', async () => {
  const f = fixture();
  const bad: unknown[] = [
    { ...task('fake-b1', 'fleet.deploy'), body: { protocol: { version: 2, kind: 'task', topic: 'fleet.deploy' } } },
    { ...task('fake-b2', 'codex'), body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } } },
    { ...task('fake-b3', 'fleet.deploy'), body: { protocol: { version: 1, kind: 'work' } } },
    { ...task('fake-b4', 'agent-a'), body: { protocol: { version: 1, kind: 'task', payload_ref: 'has space' } } },
    { ...task('fake-b5', 'agent-a'), body: { protocol: { version: 1, kind: 'task', extra: 1 } } },
  ];
  for (const envelope of bad) {
    expect((await f.post(envelope)).code).toBe(2);
  }
  expect(existsSync(join(f.root, 'bus-inbox'))).toBe(false);
  for (const args of [['--kind', 'work'], ['--topic', 'fleet'], ['--topic', 'fleet.*.x'], ['--topic', 'Fleet.*'], ['--topic', '*'], ['--kind']]) {
    expect((await f.run(['read', '--after', '0', ...args])).code, args.join(' ')).toBe(2);
  }
  expect((await f.run(['watch', '--kind', 'work', '--max-pages', '1'])).code).toBe(2);
});

it('gives each task to exactly one claimant and releases it only through its token', async () => {
  const f = fixture();
  await f.post(task('fake-job', 'fleet.deploy'));
  const first = await f.run(['next', '--to', 'fleet.deploy', '--owner', 'fake-a', '--lease-ms', '60000']);
  expect(first.code).toBe(0);
  expect(first.out[0]).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'fake-job' } } });
  const token = first.out[0]!.token as string;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.run(['next', '--to', 'fleet.deploy', '--owner', 'fake-b', '--lease-ms', '60000'])).toEqual({ code: 0, out: [{ status: 'empty' }] });
  expect(await f.run(['claim', 'acquire', '--id', 'fake-job', '--owner', 'fake-b', '--lease-ms', '60000'])).toMatchObject({ code: 1, out: [{ status: 'conflict' }] });
  expect(await f.run(['claim', 'renew', '--id', 'fake-job', '--token', 'a'.repeat(64)])).toMatchObject({ code: 1, out: [{ status: 'mismatched-token' }] });
  expect(await f.run(['claim', 'renew', '--id', 'fake-job', '--token', token])).toMatchObject({ code: 0, out: [{ status: 'renewed' }] });
  expect(await f.run(['claim', 'complete', '--id', 'fake-job', '--token', token])).toMatchObject({ code: 0, out: [{ status: 'completed' }] });
  expect(await f.run(['next', '--to', 'fleet.deploy', '--owner', 'fake-b', '--lease-ms', '60000'])).toEqual({ code: 0, out: [{ status: 'empty' }] });
});

it('releases an unfinished claim so a successor can take the same task', async () => {
  const f = fixture();
  await f.post(task('fake-retry', 'repo.phantom'));
  const first = await f.run(['next', '--to', 'repo.phantom', '--owner', 'fake-a', '--lease-ms', '60000']);
  expect(await f.run(['claim', 'release', '--id', 'fake-retry', '--token', first.out[0]!.token as string]))
    .toMatchObject({ code: 0, out: [{ status: 'released' }] });
  expect(await f.run(['next', '--to', 'repo.phantom', '--owner', 'fake-b', '--lease-ms', '60000']))
    .toMatchObject({ code: 0, out: [{ status: 'acquired', receipt: { envelope: { id: 'fake-retry' } } }] });
});

it('keeps the legacy work convention claimable and leaves other bodies alone', async () => {
  const f = fixture();
  await f.post({ id: 'fake-legacy', from: 'fake-a', to: 'agent-a', priority: 'P0', ttl: 60000, body: { kind: 'work' } });
  await f.post({ id: 'fake-note', from: 'fake-a', to: 'agent-a', priority: 'P0', ttl: 60000, body: { kind: 'note' } });
  const claimed = await f.run(['next', '--to', 'agent-a', '--owner', 'fake-a', '--lease-ms', '60000']);
  expect(claimed.out[0]).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'fake-legacy' } } });
  expect(await f.run(['next', '--to', 'agent-a', '--owner', 'fake-a', '--lease-ms', '60000']))
    .toEqual({ code: 0, out: [{ status: 'empty' }] });
});

it('rejects malformed next and claim arguments with exit 2 before touching any claim state', async () => {
  const f = fixture();
  const invalid: string[][] = [
    ['next', '--to', 'fleet.deploy', '--owner', 'fake-a'],
    ['next', '--to', 'fleet.deploy', '--owner', 'fake-a', '--lease-ms', '0'],
    ['next', '--to', 'fleet.deploy', '--owner', 'fake-a', '--lease-ms', '3600001'],
    ['next', '--to', 'fleet.deploy', '--owner', 'fake-a', '--lease-ms', '1e3'],
    ['next', '--to', 'fleet.deploy', '--owner', '--lease-ms', '1000'],
    ['next', '--to', 'fleet.deploy', '--owner', 'fake-a', '--lease-ms', '1000', '--root', '/tmp'],
    ['claim', 'steal', '--id', 'fake-job', '--token', 'a'.repeat(64)],
    ['claim', 'acquire', '--id', 'fake-job', '--owner', 'fake-a', '--lease-ms', '60000', '--token', 'a'.repeat(64)],
    ['claim', 'renew', '--id', 'fake-job', '--owner', 'fake-a', '--token', 'a'.repeat(64)],
    ['claim', 'complete', '--id', 'fake-job'],
    ['claim'],
  ];
  for (const args of invalid) {
    expect((await f.run(args)).code, args.join(' ')).toBe(2);
  }
  expect(existsSync(join(f.root, 'bus-work-claims'))).toBe(false);
});
