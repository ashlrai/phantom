import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus, type CommsBusDependencies } from '../src/cli/comms-bus.js';

// Preservation of the kind/topic bus consumption hunks from PR #5224
// (head 81306fd43e3e68fb43f51030adec4a6ecea08d71), scoped to read/watch
// filtering only. Intentionally omitted source coverage, already owned
// elsewhere: claim next/claim lifecycle (master's comms-bus-claim-route-197s
// suite, RQ-PHX-BUSCLAIMWIRE197S / #5233) and malformed-protocol post
// rejection (bus-envelope protocolIssue, covered by the bus-protocol suites).
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bus-filter-preserve-201s-'));
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
  const run = async (args: string[], deps: CommsBusDependencies = {}) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
    try {
      const code = await cmdCommsBus(args, options, { emit: (json: string) => { lines.push(json); }, ...deps });
      return { code, out: lines.map(line => JSON.parse(line) as Record<string, unknown>) };
    } finally { spy.mockRestore(); }
  };
  return { root, post, run };
}

const task = (id: string, to: string, kind = 'task', extra: Record<string, unknown> = {}) => ({
  id, from: 'fake-planner', to, priority: 'P1', ttl: 60000,
  body: { protocol: { version: 1, kind, topic: to }, text: 'fake work', ...extra },
});
const ids = (page: Record<string, unknown>) =>
  (page.messages as Array<{ envelope: { id: string } }>).map(row => row.envelope.id);
const checkpointState = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { version: number; scanCursor: number; filters: string };

it('reads and watches return only messages matching kind plus exact or namespace topic', async () => {
  const f = fixture();
  expect((await f.post(task('fake-t1', 'fleet.deploy'))).receipt.status).toBe('posted');
  expect((await f.post({ id: 'fake-s1', from: 'fake-a', to: 'codex', priority: 'P3', ttl: 60000,
    body: { protocol: { version: 1, kind: 'status' } } })).receipt.status).toBe('posted');
  expect((await f.post(task('fake-r1', 'human.mason', 'result', { payload_ref: 'artifact:fake/run-1' }))).receipt.status).toBe('posted');
  // Legacy bodies carry no protocol object and must never match kind/topic.
  expect((await f.post({ id: 'fake-legacy', from: 'fake-a', to: 'agent-a', priority: 'P0', ttl: 60000, body: { kind: 'work', text: 'x' } })).receipt.status).toBe('posted');

  const readIds = async (args: string[]) => {
    const { code, out } = await f.run(['read', '--after', '0', ...args]);
    expect(code).toBe(0);
    return ids(out[0]!);
  };
  expect(await readIds([])).toEqual(['fake-t1', 'fake-s1', 'fake-r1', 'fake-legacy']);
  expect(await readIds(['--kind', 'task'])).toEqual(['fake-t1']);
  expect(await readIds(['--kind', 'result'])).toEqual(['fake-r1']);
  expect(await readIds(['--topic', 'fleet.*'])).toEqual(['fake-t1']);
  expect(await readIds(['--topic', 'fleet.deploy'])).toEqual(['fake-t1']);
  expect(await readIds(['--topic', 'human.*'])).toEqual(['fake-r1']);
  expect(await readIds(['--topic', 'repo.*'])).toEqual([]);
  expect(await readIds(['--topic', 'fleet.deploy', '--kind', 'result'])).toEqual([]);

  // kind/topic compose with the existing selectors.
  expect(await readIds(['--to', 'codex', '--kind', 'status'])).toEqual(['fake-s1']);
  expect(await readIds(['--kind', 'task', '--from', 'fake-planner', '--priority', 'P1'])).toEqual(['fake-t1']);
  expect(await readIds(['--kind', 'task', '--exclude-from', 'fake-planner'])).toEqual([]);
  expect(await readIds(['--kind', 'task', '--topic', 'fleet.*', '--id', 'fake-t1'])).toEqual(['fake-t1']);

  // watch applies the same filters and stays bounded by --max-pages.
  const watched = await f.run(['watch', '--after', '0', '--kind', 'task', '--topic', 'fleet.*', '--max-pages', '1', '--interval-ms', '100']);
  expect(watched.code).toBe(0);
  expect(watched.out).toHaveLength(1);
  expect(watched.out[0]!.status).toBe('ok');
  expect(ids(watched.out[0]!)).toEqual(['fake-t1']);

  // A protocol-less message and a wrong-kind message on the same topic are both excluded.
  await f.post({ id: 'fake-plain', from: 'fake-a', to: 'fleet.deploy', priority: 'P2', ttl: 60000, body: { text: 'no protocol' } });
  const after = await f.run(['read', '--after', '4', '--topic', 'fleet.deploy']);
  expect(after.code).toBe(0);
  expect(ids(after.out[0]!)).toEqual([]);
});

it('rejects invalid kind and topic values with exit 2 before any checkpoint advance', async () => {
  const f = fixture();
  await f.post(task('fake-i1', 'fleet.deploy'));
  const checkpoint = join(f.root, 'fake-checkpoint.json');
  const first = await f.run(['read', '--checkpoint', checkpoint, '--kind', 'task']);
  expect(first.code).toBe(0);
  expect(ids(first.out[0]!)).toEqual(['fake-i1']);
  const stored = checkpointState(checkpoint);
  expect(stored.scanCursor).toBeGreaterThan(0);
  expect(stored.filters).toBe(JSON.stringify({ kind: 'task' }));

  for (const args of [['--kind', 'work'], ['--topic', 'fleet'], ['--topic', 'fleet.*.x'], ['--topic', 'Fleet.*'], ['--topic', '*'], ['--kind'], ['--topic']]) {
    const { code, out } = await f.run(['read', '--after', '0', ...args]);
    expect(code, args.join(' ')).toBe(2);
    expect(out[0]).toEqual({ status: 'invalid' });
  }
  expect((await f.run(['watch', '--kind', 'work', '--max-pages', '1'])).code).toBe(2);

  // The invalid attempts never opened or advanced the checkpoint.
  const after = checkpointState(checkpoint);
  expect(after.scanCursor).toBe(stored.scanCursor);
  expect(after.filters).toBe(stored.filters);
});

it('binds checkpoint identity to kind/topic filters: same filters resume, different filters are rejected', async () => {
  const f = fixture();
  await f.post(task('fake-c1', 'fleet.deploy'));
  await f.post(task('fake-c2', 'fleet.deploy', 'status'));
  const checkpoint = join(f.root, 'fake-checkpoint.json');

  const first = await f.run(['read', '--checkpoint', checkpoint, '--kind', 'task', '--topic', 'fleet.*']);
  expect(first.code).toBe(0);
  expect(ids(first.out[0]!)).toEqual(['fake-c1']);
  expect(checkpointState(checkpoint).filters).toBe(JSON.stringify({ kind: 'task', topic: 'fleet.*' }));

  // Unchanged filters resume from the stored cursor: no replay, and the
  // already-scanned status message stays excluded by the filter.
  await f.post(task('fake-c3', 'fleet.deploy'));
  const second = await f.run(['read', '--checkpoint', checkpoint, '--kind', 'task', '--topic', 'fleet.*']);
  expect(second.code).toBe(0);
  expect(ids(second.out[0]!)).toEqual(['fake-c3']);
  const settled = checkpointState(checkpoint);

  // Reusing the checkpoint under different kind/topic selection fails closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    for (const extra of [['--kind', 'status'], ['--topic', 'repo.*'], ['--kind', 'task']]) {
      const code = await cmdCommsBus(['read', '--checkpoint', checkpoint, ...extra], { root: f.root });
      expect(code).toBe(1);
    }
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
  expect(checkpointState(checkpoint).scanCursor).toBe(settled.scanCursor);
});

it('advertises the kind and topic filters in bus help', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['--help'])).toBe(0);
    expect(await cmdCommsBus(['read', '--help'])).toBe(0);
    expect(await cmdCommsBus(['watch', '--help'])).toBe(0);
  } finally { spy.mockRestore(); }
  const help = lines.join('\n');
  expect(help).toContain('--kind');
  expect(help).toContain('--topic');
  expect(help).toContain('task|result|review|status|question');
});
