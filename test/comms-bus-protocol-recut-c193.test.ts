import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus, type CommsBusDependencies } from '../src/cli/comms-bus.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bus-protocol-recut-c193-'));
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

const task = (id: string, to: string, kind = 'task') => ({
  id, from: 'fake-planner', to, priority: 'P1', ttl: 60000,
  body: { protocol: { version: 1, kind, topic: to }, text: 'fake work' },
});

it('watch honours --kind and --topic and stops after one bounded page', async () => {
  const f = fixture();
  await f.post(task('fake-w1', 'repo.phantom.bus'));
  await f.post(task('fake-w2', 'repo.phantom.bus', 'status'));
  await f.post(task('fake-w3', 'fleet.other'));
  const { code, out } = await f.run(['watch', '--after', '0', '--kind', 'task', '--topic', 'repo.*', '--max-pages', '1', '--interval-ms', '100']);
  expect(code).toBe(0);
  expect(out).toHaveLength(1);
  const page = out[0]!;
  expect(page.status).toBe('ok');
  const ids = (page.messages as Array<{ envelope: { id: string } }>).map(row => row.envelope.id);
  expect(ids).toEqual(['fake-w1']);
});

it('checkpoint identity includes protocol filters and rejects reuse under different filters', async () => {
  const f = fixture();
  await f.post(task('fake-c1', 'fleet.deploy'));
  await f.post(task('fake-c2', 'fleet.deploy', 'status'));
  const checkpoint = join(f.root, 'fake-checkpoint.json');
  const first = await f.run(['read', '--checkpoint', checkpoint, '--kind', 'task']);
  expect(first.code).toBe(0);
  expect((first.out[0]!.messages as Array<{ envelope: { id: string } }>).map(row => row.envelope.id)).toEqual(['fake-c1']);
  const second = await f.run(['read', '--checkpoint', checkpoint, '--kind', 'task']);
  expect(second.code).toBe(0);
  expect(second.out[0]!.messages).toEqual([]);
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    const mismatched = await cmdCommsBus(['read', '--checkpoint', checkpoint, '--kind', 'status'], { root: f.root });
    expect(mismatched).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('bus help advertises the protocol verbs and filters the recut adds', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['--help'])).toBe(0);
  } finally { spy.mockRestore(); }
  const help = lines.join('\n');
  expect(help).toContain('comms bus next');
  expect(help).toContain('comms bus claim');
  expect(help).toContain('--kind');
  expect(help).toContain('--topic');
});
